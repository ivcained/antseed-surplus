import test from 'node:test';
import assert from 'node:assert/strict';
import * as topup from '../lib/topup.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, Interface, keccak256, Transaction, zeroPadValue } from 'ethers';

const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)']);
const sellerWallet = new Wallet('0x' + '11'.repeat(32)); // Deliberately synthetic offline signer.
const payout = '0x3333333333333333333333333333333333333333';
const receiver = '0x2222222222222222222222222222222222222222';
const blockHash = '0x' + 'ab'.repeat(32);
const incomeHash = '0x' + 'cd'.repeat(32);
const channelEvents = new Interface(['event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)']);
function settlementLog(amount) {
  return {address:topup.CHANNELS,...channelEvents.encodeEventLog(channelEvents.getEvent('ChannelSettled'),['0x'+'12'.repeat(32),receiver,sellerWallet.address,amount,amount,amount,0n,'0x'])};
}
function transferLog(from, to, amount, hash = incomeHash) {
  const encoded = token.encodeEventLog(token.getEvent('Transfer'), [from, to, amount]);
  return { address: topup.USDC, ...encoded, transactionHash: hash, blockNumber: 12, blockHash, index: 0 };
}
function fixture(t, overrides = {}) {
  const stateDir = mkdtempSync(join(process.env.TMPDIR, 'topup-test-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const income = transferLog(payout, sellerWallet.address, overrides.incomeAmount ?? 500000n);
  const state = { signed: 0, sent: 0, balanceCalls: 0, receipt: null, income, ...overrides };
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }),
    getBlockNumber: async () => 20,
    getBlock: async () => ({ hash: blockHash }),
    getCode: async () => '0x6000',
    getLogs: async () => state.logs ?? [income],
    getTransactionReceipt: async (hash) => hash === incomeHash ? { status: 1, hash, blockNumber: 12, blockHash, logs: [income,settlementLog(overrides.incomeAmount ?? 500000n)] } : state.receipt,
    getBalance: async () => 1000000000000000n,
    call: async () => token.encodeFunctionResult('balanceOf', [3000000n]),
    getFeeData: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 100000n }),
    estimateGas: async () => 60000n,
    getTransactionCount: async () => 3,
    broadcastTransaction: async (raw) => {
      state.sent++;
      const tx = Transaction.from(raw);
      const journal = JSON.parse(readFileSync(join(stateDir, 'topup-journal.json'), 'utf8'));
      assert.equal(journal.entries.at(-1).rawTransaction, raw, 'durability before broadcast');
      assert.equal(journal.entries.at(-1).hash, keccak256(raw));
      if (state.timeout) throw new Error('RPC timeout');
      const amount = token.decodeFunctionData('transfer', tx.data)[1];
      const log = transferLog(sellerWallet.address, receiver, amount, tx.hash);
      state.receipt = { hash: tx.hash, status: 1, blockNumber: 12, blockHash, logs: [log] };
      return { hash: tx.hash };
    },
  };
  const api = {
    balance: async () => {
      state.balanceCalls++;
      return { credit_balance_usdc: state.receipt ? '600000' : '100000', usdc_available_usdc: '0', pending_deposit_usdc: '0' };
    },
    depositAddress: async () => ({ address: receiver, chain_id: 8453, token_address: topup.USDC }),
  };
  const signer = { getAddress: () => sellerWallet.getAddress(), signTransaction: async (tx) => { state.signed++; return sellerWallet.signTransaction(tx); } };
  const config = { stateDir, startBlock: 10, payoutContracts: [payout], confirmations: 2, receiptPollAttempts: 1, creditPollAttempts: 1, pollMs: 0,
    policy: { ...input().policy, maxFeePerGasWei: '2000000', maxGasCostWei: '1000000000000', l1FeeReserveWei: '100000000000' } };
  return { state, provider, api, signer, config, adapters: { provider, api, signer, sleep: async () => {} } };
}

const input = (overrides = {}) => ({
  balance: { credit_balance_usdc: '100000', usdc_available_usdc: '0', pending_deposit_usdc: '0' },
  revenueMicro: '2000000', alreadySentMicro: '250000', walletUsdcMicro: '3000000', sentTodayMicro: '0',
  ethWei: '1000000000000000', gasCostWei: '10000000000000',
  policy: { thresholdMicro: '200000', targetMicro: '2000000', maxMicro: '1000000', dailyCapMicro: '1000000', walletReserveMicro: '100000', ethReserveWei: '100000000000000' },
  ...overrides,
});

test('plan caps at per-transaction maximum using integer micros', () => {
  assert.equal(typeof topup.planTopup, 'function', 'missing pure treasury planner');
  assert.equal(topup.planTopup(input()).amountMicro, '1000000');
});
test('plan uses fresh revenue less journal commitments, never starting wallet balance', () => {
  assert.equal(topup.planTopup(input({ revenueMicro: '260000' })).amountMicro, '10000');
  assert.equal(topup.planTopup(input({ revenueMicro: '0', alreadySentMicro: '0' })).amountMicro, '0');
});
test('plan respects wallet reserve, daily cap and target', () => {
  assert.equal(topup.planTopup(input({ walletUsdcMicro: '100005' })).amountMicro, '5');
  assert.equal(topup.planTopup(input({ sentTodayMicro: '999999' })).amountMicro, '1');
  const i = input(); i.policy.targetMicro = '100007'; i.policy.thresholdMicro = '100005';
  assert.equal(topup.planTopup(i).amountMicro, '7');
});
test('plan accounts for available credit and pending deposits before buying again', () => {
  const balance = { credit_balance_usdc: '100000', usdc_available_usdc: '200000', pending_deposit_usdc: '1' };
  assert.equal(topup.planTopup(input({ balance })).amountMicro, '0');
});
test('plan fails closed on decimal, numeric, negative or missing micro API fields', () => {
  for (const bad of ['0.5', 2, '-1', undefined]) {
    const i = input(); i.balance.credit_balance_usdc = bad;
    assert.throws(() => topup.planTopup(i), /integer micro/i);
  }
});
test('plan refuses inadequate ETH gas reserve', () => {
  assert.throws(() => topup.planTopup(input({ ethWei: '1' })), /gas reserve/i);
});
test('deposit validation requires Base and native USDC', () => {
  assert.equal(typeof topup.validateDeposit, 'function');
  const deposit = { address: '0x2222222222222222222222222222222222222222', chain_id: 8453, token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  assert.equal(topup.validateDeposit(deposit).address, deposit.address);
  assert.throws(() => topup.validateDeposit({ ...deposit, chain_id: 1 }), /Base/i);
  assert.throws(() => topup.validateDeposit({ ...deposit, token_address: deposit.address }), /native USDC/i);
  assert.throws(() => topup.validateDeposit({ ...deposit, address: '0x0000000000000000000000000000000000000000' }), /address/i);
});


test('dry run verifies fresh payout revenue but never signs or sends', async (t) => {
  assert.equal(typeof topup.executeTopup, 'function', 'missing execution coordinator');
  const f = fixture(t);
  const result = await topup.executeTopup(f.config, f.adapters);
  assert.equal(result.amountMicro, '500000');
  assert.equal(result.status, 'dry-run');
  assert.equal(f.state.signed, 0);
  assert.equal(f.state.sent, 0);
});
test('canonical revenue scan covers an aged checkpoint within the Base public RPC 1000-block limit', async (t) => {
  const f = fixture(t);
  const head = 2517;
  const confirmations = 3;
  const hashFor = (n) => '0x' + n.toString(16).padStart(64, '0');
  const logs = [];
  const receipts = new Map();
  const expectedReceiptHashes = [];
  const addTransfer = (blockNumber, amount, { outgoing = false, settled = true } = {}) => {
    const hash = hashFor(logs.length + 1);
    const log = { ...transferLog(outgoing ? sellerWallet.address : payout,
      outgoing ? receiver : sellerWallet.address, amount, hash), blockNumber, blockHash: hashFor(blockNumber + 10000) };
    logs.push(log);
    receipts.set(hash, { status: 1, hash, blockNumber, blockHash: log.blockHash,
      logs: [log, ...(!outgoing && settled ? [settlementLog(amount)] : [])] });
    if (outgoing || blockNumber <= head - confirmations + 1) expectedReceiptHashes.push(hash);
  };
  // Both sides of each chunk boundary, the first block, and the last confirmed block.
  for (const [block, amount] of [[11, 110000n], [1010, 120000n], [1011, 130000n],
    [2010, 140000n], [2011, 150000n], [2515, 160000n]]) addTransfer(block, amount);
  addTransfer(1510, 900000n, { settled: false }); // A canonical transfer alone is not revenue.
  addTransfer(2516, 800000n); // Unconfirmed income must not fund a topup.
  addTransfer(1010, 50000n, { outgoing: true });
  addTransfer(2011, 60000n, { outgoing: true });
  addTransfer(head, 70000n, { outgoing: true }); // Even unconfirmed outflows consume budget.
  const queries = [];
  const receiptReads = [];
  const canonicalReads = [];
  f.provider.getBlockNumber = async () => head;
  f.provider.getBlock = async (block) => {
    canonicalReads.push(block);
    return { hash: hashFor(block + 10000) };
  };
  f.provider.getLogs = async (query) => {
    const { fromBlock, toBlock, topics } = query;
    queries.push(query);
    if (toBlock - fromBlock + 1 > 1000) {
      throw Object.assign(new Error('Block range too large for public access: maximum 1000 blocks'), { code: -32602 });
    }
    assert.equal(query.address, topup.USDC);
    assert.equal(topics[0], token.getEvent('Transfer').topicHash);
    const incoming = Array.isArray(topics[1]);
    assert.deepEqual(topics.slice(1), incoming
      ? [[zeroPadValue(payout, 32)], zeroPadValue(sellerWallet.address, 32)]
      : [zeroPadValue(sellerWallet.address, 32)]);
    const matches = logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock &&
      (incoming ? log.topics[2] === topics[2] && topics[1].includes(log.topics[1]) : log.topics[1] === topics[1]));
    return matches.flatMap((log) => [log, log]); // Duplicate RPC results must not inflate either side.
  };
  f.provider.getTransactionReceipt = async (hash) => {
    receiptReads.push(hash);
    assert.ok(receipts.has(hash), 'only fixture receipts may be read');
    return receipts.get(hash);
  };
  const result = await topup.executeTopup({ ...f.config, confirmations }, f.adapters);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.confirmedThroughBlock, 2515);
  assert.equal(result.remainingRevenueMicro, '630000'); // 810000 income - 180000 outflows.
  assert.equal(result.amountMicro, '630000');
  for (const incoming of [true, false]) {
    const ranges = queries.filter((query) => Array.isArray(query.topics[1]) === incoming);
    const coverage = ranges.flatMap(({ fromBlock, toBlock }) => {
      assert.ok(toBlock >= fromBlock && toBlock - fromBlock + 1 <= 1000);
      return Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => fromBlock + i);
    });
    assert.deepEqual(coverage, Array.from({ length: head - f.config.startBlock }, (_, i) => f.config.startBlock + i + 1),
      'each direction must cover every block after the checkpoint exactly once through head');
  }
  assert.deepEqual(receiptReads.toSorted(), expectedReceiptHashes.toSorted(), 'deduplicate logs before receipt reads');
  assert.deepEqual(canonicalReads.toSorted((a, b) => a - b), [f.config.startBlock,
    ...expectedReceiptHashes.map((hash) => receipts.get(hash).blockNumber)].toSorted((a, b) => a - b));
  assert.equal(f.state.signed, 0);
  assert.equal(f.state.sent, 0);
});

test('only native USDC from explicit payout contracts after checkpoint is counted', async (t) => {
  const f = fixture(t);
  f.state.logs = [f.state.income, f.state.income,
    transferLog(receiver, sellerWallet.address, 999999999n),
    { ...f.state.income, blockNumber: 10 },
    { ...f.state.income, address: receiver }];
  const result = await topup.executeTopup(f.config, f.adapters);
  assert.equal(result.amountMicro, '500000');
});
test('execution persists private exact signed transaction before broadcast and confirms receipt plus credit', async (t) => {
  const f = fixture(t);
  const result = await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  assert.equal(result.status, 'credit-observed');
  assert.equal(f.state.sent, 1);
  assert.equal(f.state.signed, 1);
  const journalFile = join(f.config.stateDir, 'topup-journal.json');
  assert.equal(statSync(journalFile).mode & 0o777, 0o600);
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  assert.equal(journal.entries[0].hash, result.hash);
  assert.equal(journal.entries[0].nonce, 3);
  assert.ok(journal.entries[0].rawTransaction.startsWith('0x'));
  assert.equal(JSON.stringify(result).includes(journal.entries[0].rawTransaction), false);
  const again = await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  assert.equal(again.amountMicro, '0');
  assert.equal(f.state.sent, 1);
});
test('send timeout remains journaled and retry never signs or broadcasts a duplicate', async (t) => {
  const f = fixture(t, { timeout: true });
  const first = await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  assert.equal(first.status, 'broadcast-uncertain');
  const second = await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  assert.equal(second.hash, first.hash);
  assert.equal(second.status, 'broadcast-uncertain');
  assert.equal(f.state.signed, 1);
  assert.equal(f.state.sent, 1);
});
test('lock is acquired before balance or chain checks and blocks concurrent invocation', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.config.stateDir, 'topup.lock'), 'already-running', { mode: 0o600 });
  await assert.rejects(() => topup.executeTopup(f.config, f.adapters), /lock/i);
  assert.equal(f.state.balanceCalls, 0);
});
test('wrong chain, absent checkpoint, missing payout contracts and excessive fees fail closed', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => topup.executeTopup({ ...f.config, startBlock: undefined }, f.adapters), /checkpoint/i);
  await assert.rejects(() => topup.executeTopup({ ...f.config, payoutContracts: [] }, f.adapters), /payout/i);
  f.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(() => topup.executeTopup(f.config, f.adapters), /Base/i);
  f.provider.getNetwork = async () => ({ chainId: 8453n });
  f.provider.getFeeData = async () => ({ maxFeePerGas: 999999999n, maxPriorityFeePerGas: 1n });
  await assert.rejects(() => topup.executeTopup({ ...f.config, execute: true }, f.adapters), /fee/i);
  assert.equal(f.state.sent, 0);
});
test('a reverted payout receipt is not revenue', async (t) => {
  const f = fixture(t);
  f.provider.getTransactionReceipt = async () => ({ status: 0, logs: [f.state.income], blockHash });
  const result = await topup.executeTopup(f.config, f.adapters);
  assert.equal(result.amountMicro, '0');
});
test('journal deletion during final pre-broadcast RPC prevents send', async (t) => {
  const f = fixture(t);
  let nonceChecks = 0;
  f.provider.getTransactionCount = async () => {
    nonceChecks++;
    if (nonceChecks === 2) rmSync(join(f.config.stateDir, 'topup-journal.json'));
    return 3;
  };
  await assert.rejects(() => topup.executeTopup({ ...f.config, execute: true }, f.adapters), /journal|ENOENT/i);
  assert.equal(f.state.sent, 0);
});


test('unrelated wallet outflow consumes the revenue budget even with a large starting wallet balance', async (t) => {
  const f = fixture(t);
  const outHash = '0x' + 'ee'.repeat(32);
  const outgoing = transferLog(sellerWallet.address, receiver, 500000n, outHash);
  f.state.logs = [f.state.income, outgoing];
  const getReceipt = f.provider.getTransactionReceipt;
  f.provider.getTransactionReceipt = async (hash) => hash === outHash ? { status: 1, hash, blockNumber: 12, blockHash, logs: [outgoing] } : getReceipt(hash);
  const result = await topup.executeTopup(f.config, f.adapters);
  assert.equal(result.amountMicro, '0');
});
test('a prepared transaction recovered on a later day consumes the actual attempt day cap', async (t) => {
  const f = fixture(t, { incomeAmount: 1000000n });
  f.config.policy.maxMicro = '500000'; f.config.policy.dailyCapMicro = '500000';
  let now = new Date('2026-10-27T12:00:00Z'); f.adapters.now = () => now;
  const originalNonce = f.provider.getTransactionCount;
  let checks = 0;
  f.provider.getTransactionCount = async () => { if (++checks === 2) throw new Error('before-send interruption'); return 3; };
  await assert.rejects(() => topup.executeTopup({ ...f.config, execute: true }, f.adapters), /interruption/);
  assert.equal(f.state.sent, 0);
  now = new Date('2026-10-28T12:00:00Z'); f.provider.getTransactionCount = originalNonce;
  await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  f.state.receipt = null;
  const next = await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  assert.equal(next.amountMicro, '0');
  assert.equal(f.state.sent, 1);
});
test('additional Base fee reserve is mandatory and included in maximum fee guard', async (t) => {
  const f = fixture(t);
  delete f.config.policy.l1FeeReserveWei;
  await assert.rejects(() => topup.executeTopup({ ...f.config, execute: true }, f.adapters), /L1.*reserve/i);
  assert.equal(f.state.sent, 0);
});


test('CLI offers help without credentials or network', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, ['scripts/topup.mjs', '--help'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dry.run/i);
  assert.match(run.stdout, /--execute/);
});
test('CLI refuses unknown arguments and absent explicit env file', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (args) => spawnSync(process.execPath, ['scripts/topup.mjs', ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH } });
  const unknown = run(['--exectue']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown argument/i);
  const absent = run(['--env', '.not-an-env-file']);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /env file/i);
});
test('CLI config remains dry-run even when TOPUP_EXECUTE=true and enforces one-USDC run maximum', async () => {
  const cli = await import('../scripts/topup.mjs');
  const env = { TOPUP_EXECUTE: 'true', TOPUP_START_BLOCK: '123', ANTSEED_PAYOUT_CONTRACTS: payout };
  const config = cli.topupConfig(env, false);
  assert.equal(config.execute, false);
  assert.equal(config.startBlock, 123);
  assert.equal(config.policy.maxMicro, '1000000');
  assert.throws(() => cli.topupConfig({ ...env, TOPUP_MAX_MICRO: '1000001' }, true), /one USDC/i);
});


test('CLI reads immutable revenue checkpoint created by setup when no block override is set', async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'topup-checkpoint-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'revenue-checkpoint.json'),JSON.stringify({chainId:8453,startBlock:123,payoutContracts:[payout]}),{mode:0o600});
 const {topupConfig}=await import('../scripts/topup.mjs');const c=topupConfig({STATE_DIR:dir});
 assert.equal(c.startBlock,123);assert.deepEqual(c.payoutContracts,[payout]);
});
test('attempt-day reservation uses the day after the final RPC await crosses midnight', async (t) => {
  const f = fixture(t);
  let now = new Date('2026-10-27T23:59:59Z'); f.adapters.now = () => now;
  let calls = 0;
  f.provider.getTransactionCount = async () => {
    if (++calls === 2) now = new Date('2026-10-28T00:00:01Z');
    return 3;
  };
  await topup.executeTopup({ ...f.config, execute: true }, f.adapters);
  const journal = JSON.parse(readFileSync(join(f.config.stateDir, 'topup-journal.json'), 'utf8'));
  assert.equal(journal.entries[0].attemptedAt.slice(0, 10), '2026-10-28');
});
test('a successful payout receipt must bind the exact transaction hash and block number', async (t) => {
  const f = fixture(t);
  f.provider.getTransactionReceipt = async () => ({ status: 1, hash: '0x' + 'ff'.repeat(32), blockNumber: 99, blockHash, logs: [f.state.income] });
  await assert.rejects(() => topup.executeTopup(f.config, f.adapters), /receipt/i);
});
test('receipt polling waits for confirmations rather than treating a mined tx as an ambiguous broadcast', async t=>{
 const f=fixture(t);let reads=0;
 f.provider.getBlockNumber=async()=>{reads++;return reads===2?12:20;};
 const r=await topup.executeTopup({...f.config,execute:true,receiptPollAttempts:2},f.adapters);
 assert.equal(r.status,'credit-observed');assert.equal(f.state.sent,1);
});
