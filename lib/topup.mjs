import { getAddress, ZeroAddress, Interface, zeroPadValue, Transaction, keccak256 } from 'ethers';
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const BASE_CHAIN_ID = 8453;
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const CHANNELS = '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d';

function uint(value, name = 'value') {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be an unsigned integer micro/base-unit string`);
  return BigInt(value);
}
function address(value) {
  let result;
  try { result = getAddress(value); } catch { throw new Error('Invalid address'); }
  if (result === ZeroAddress) throw new Error('Zero address forbidden');
  return result;
}
function balanceTotals(balance) {
  const credit = uint(balance?.credit_balance_usdc, 'credit_balance_usdc');
  const available = uint(balance?.usdc_available_usdc, 'usdc_available_usdc');
  const pending = uint(balance?.pending_deposit_usdc, 'pending_deposit_usdc');
  // credit_balance_usdc is already the combined spendable fiat + USDC amount.
  return { spendable: credit, pending, effective: credit + pending };
}
export function validateDeposit(deposit) {
  if (deposit?.chain_id !== BASE_CHAIN_ID) throw new Error('Deposit must use Base chain 8453');
  if (address(deposit.token_address) !== USDC) throw new Error('Deposit must use native USDC');
  return { address: address(deposit.address), chain_id: BASE_CHAIN_ID, token_address: USDC };
}
export function planTopup(input) {
  const b = balanceTotals(input.balance);
  const p = input.policy;
  const threshold = uint(p.thresholdMicro, 'thresholdMicro');
  const target = uint(p.targetMicro, 'targetMicro');
  const max = uint(p.maxMicro, 'maxMicro');
  const cap = uint(p.dailyCapMicro, 'dailyCapMicro');
  const reserve = uint(p.walletReserveMicro, 'walletReserveMicro');
  const ethReserve = uint(p.ethReserveWei, 'ethReserveWei');
  const revenue = uint(input.revenueMicro, 'revenueMicro');
  const spent = uint(input.alreadySentMicro, 'alreadySentMicro');
  const wallet = uint(input.walletUsdcMicro, 'walletUsdcMicro');
  const today = uint(input.sentTodayMicro, 'sentTodayMicro');
  const eth = uint(input.ethWei, 'ethWei');
  const gas = uint(input.gasCostWei, 'gasCostWei');
  const clamp = (x) => x > 0n ? x : 0n;
  let amount = 0n;
  let reason = 'above-threshold';
  if (b.pending > 0n) reason = 'pending-deposit';
  else if (b.effective < threshold) {
    amount = [clamp(target - b.effective), max, clamp(cap - today), clamp(revenue - spent), clamp(wallet - reserve)].reduce((a, v) => a < v ? a : v);
    reason = amount > 0n ? 'funded-by-fresh-revenue' : 'no-eligible-budget';
  }
  if (amount>0n && eth < ethReserve + gas) throw new Error('Insufficient ETH gas reserve');
  return { amountMicro: String(amount), reason, effectiveBalanceMicro: String(b.effective), remainingRevenueMicro: String(clamp(revenue - spent)) };
}


const erc20 = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function transfer(address,uint256) returns(bool)',
  'function balanceOf(address) view returns(uint256)',
]);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${label}`);
  return value;
}
function privateRegular(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Journal/lock must be a private regular file');
}
function lockedStore(directory) {
  const dir = resolve(directory ?? '.state');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('State directory must not be a symlink');
  chmodSync(dir, 0o700);
  const lock = join(dir, 'topup.lock');
  const file = join(dir, 'topup-journal.json');
  const owner = randomUUID();
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw new Error('Topup lock exists; inspect prior process before manual removal'); }
  writeFileSync(fd, owner); fsyncSync(fd); closeSync(fd);
  let expected = null;
  const assertLock = () => {
    privateRegular(lock);
    if (readFileSync(lock, 'utf8') !== owner) throw new Error('Topup lock ownership lost');
  };
  const assertJournal = () => {
    assertLock();
    if (expected !== null) {
      privateRegular(file);
      if (readFileSync(file, 'utf8') !== expected) throw new Error('Journal changed; refusing transaction');
    } else {
      try { lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      throw new Error('Unexpected journal creation');
    }
  };
  return {
    load() {
      assertLock();
      try { privateRegular(file); expected = readFileSync(file, 'utf8'); return JSON.parse(expected); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    save(journal) {
      assertJournal();
      const text = JSON.stringify(journal, null, 2) + '\n';
      const tmp = join(dir, `.topup-${randomUUID()}.tmp`);
      const out = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(out, text); fsyncSync(out); } finally { closeSync(out); }
      renameSync(tmp, file);
      const parent = openSync(dir, 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
      privateRegular(file);
      if (readFileSync(file, 'utf8') !== text) throw new Error('Journal persistence readback failed');
      expected = text;
    },
    assert: assertJournal,
    close() {
      try { assertLock(); unlinkSync(lock); } catch { /* Never remove somebody else's lock. */ }
    },
  };
}
function transfer(log) {
  try {
    if (address(log.address) !== USDC || log.removed) return null;
    const decoded = erc20.parseLog(log);
    if (decoded?.name !== 'Transfer') return null;
    return { from: address(decoded.args.from), to: address(decoded.args.to), amount: decoded.args.value };
  } catch { return null; }
}
function sameLog(a, b) {
  return a.transactionHash === b.transactionHash && a.blockHash === b.blockHash && a.index === b.index &&
    a.address.toLowerCase() === b.address.toLowerCase() && a.data === b.data && JSON.stringify(a.topics) === JSON.stringify(b.topics);
}
const channelEvents = new Interface(['event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)']);
export function settlementPayoutMatches(receipt, seller, payoutContracts) {
  let settled=0n,paid=0n;
  for(const log of receipt.logs ?? []) {
    try {
      if(address(log.address)===CHANNELS) {
        const event=channelEvents.parseLog(log);
        if(event?.name==='ChannelSettled' && address(event.args.seller)===address(seller) && event.args.delta>=event.args.platformFee) settled+=event.args.delta-event.args.platformFee;
      }
    }catch{/* Ignore unrelated receipt logs. */}
    const event=transfer(log);
    if(event && event.to===address(seller) && payoutContracts.map(address).includes(event.from))paid+=event.amount;
  }
  return settled>0n && settled===paid;
}
async function scanRevenue(provider, identity, confirmedBlock, head, entries) {
  let total = 0n;
  let externalOutflows = 0n;
  const ownHashes = new Set(entries.map((e) => e.hash));
  const seen = new Set();
  const receipts = new Map();
  // Base public RPC limits eth_getLogs to 1000 blocks, inclusive.
  for (let start = identity.startBlock + 1; start <= head; start += 1000) {
    const end = Math.min(start + 999, head);
    const incoming = await provider.getLogs({ address: USDC, fromBlock: start, toBlock: end,
      topics: [erc20.getEvent('Transfer').topicHash, identity.payoutContracts.map((a) => zeroPadValue(a, 32)), zeroPadValue(identity.seller, 32)] });
    const outgoing = await provider.getLogs({ address: USDC, fromBlock: start, toBlock: end,
      topics: [erc20.getEvent('Transfer').topicHash, zeroPadValue(identity.seller, 32)] });
    const logs = [...incoming, ...outgoing];
    for (const log of logs) {
      const event = transfer(log);
      const isIncome = event && event.to === identity.seller && identity.payoutContracts.includes(event.from) && log.blockNumber <= confirmedBlock;
      const isExternalSpend = event && event.from === identity.seller && !ownHashes.has(log.transactionHash);
      if ((!isIncome && !isExternalSpend) ||
          !Number.isSafeInteger(log.blockNumber) || log.blockNumber < start || log.blockNumber > end || !Number.isSafeInteger(log.index)) continue;
      const key = `${log.transactionHash}:${log.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let receipt = receipts.get(log.transactionHash);
      if (!receipt) { receipt = await provider.getTransactionReceipt(log.transactionHash); receipts.set(log.transactionHash, receipt); }
      if (!receipt || receipt.status !== 1) continue;
      const canonical = await provider.getBlock(log.blockNumber);
      if (receipt.hash !== log.transactionHash || receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash || canonical?.hash !== log.blockHash || !receipt.logs.some((l) => sameLog(l, log))) throw new Error('Revenue receipt/log canonicality mismatch');
      if (isIncome && settlementPayoutMatches(receipt,identity.seller,identity.payoutContracts)) total += event.amount;
      if (isExternalSpend) externalOutflows += event.amount;
    }
  }
  return total > externalOutflows ? total - externalOutflows : 0n;
}
async function walletFunds(provider, seller) {
  const [eth, encoded] = await Promise.all([
    provider.getBalance(seller), provider.call({ to: USDC, data: erc20.encodeFunctionData('balanceOf', [seller]) }),
  ]);
  return { ethWei: String(eth), walletUsdcMicro: String(erc20.decodeFunctionResult('balanceOf', encoded)[0]) };
}
async function fees(provider, policy, transaction) {
  if (policy.l1FeeReserveWei === undefined || uint(policy.l1FeeReserveWei) === 0n) throw new Error('Positive conservative Base L1 fee reserve required');
  const fee = await provider.getFeeData();
  const maxFeePerGas = fee.maxFeePerGas;
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
  if (typeof maxFeePerGas !== 'bigint' || maxFeePerGas <= 0n || maxFeePerGas > uint(policy.maxFeePerGasWei, 'maxFeePerGasWei') ||
      typeof maxPriorityFeePerGas !== 'bigint' || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas) throw new Error('Unsafe or unavailable gas fee');
  const estimated = await provider.estimateGas(transaction);
  const gasLimit = (estimated * 120n + 99n) / 100n;
  const gasCost = gasLimit * maxFeePerGas + uint(policy.l1FeeReserveWei ?? '0', 'l1FeeReserveWei');
  if (gasCost > uint(policy.maxGasCostWei, 'maxGasCostWei')) throw new Error('Gas fee exceeds total fee guard');
  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit, gasCost };
}
function validateEntry(entry, identity) {
  const tx = Transaction.from(entry.rawTransaction);
  const decoded = erc20.decodeFunctionData('transfer', tx.data);
  if (tx.hash !== entry.hash || keccak256(entry.rawTransaction) !== entry.hash || tx.from !== identity.seller || tx.chainId !== 8453n ||
      tx.to !== USDC || tx.value !== 0n || tx.nonce !== entry.nonce || address(decoded[0]) !== address(entry.receiver) ||
      decoded[1] !== uint(entry.amountMicro, 'journal amountMicro') || decoded[1] === 0n ||
      !['prepared', 'broadcast-uncertain', 'mined', 'credit-observed', 'reverted'].includes(entry.status) || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('Invalid signed journal entry');
  uint(entry.preSpendableMicro, 'preSpendableMicro');
  return tx;
}
async function reconcile(entry, journal, store, config, adapters) {
  const { provider, api, sleep = pause } = adapters;
  const depositConfirmations=(await api.balance()).deposit_min_confirmations;
  if(depositConfirmations!==undefined){integer(depositConfirmations,'Surplus deposit confirmations',1);config={...config,confirmations:Math.max(config.confirmations,depositConfirmations)};}
  if (entry.status === 'reverted') throw new Error('Prior topup reverted; manual terminal-outcome review required');
  for (let i = 0; i < (config.receiptPollAttempts ?? 3); i++) {
    const receipt = await provider.getTransactionReceipt(entry.hash);
    if (receipt) {
      if (receipt.hash !== entry.hash) throw new Error('Topup receipt hash mismatch');
      const head = await provider.getBlockNumber();
      const block = await provider.getBlock(receipt.blockNumber);
      if (block?.hash !== receipt.blockHash) throw new Error('Topup receipt is not canonical');
      if (head - receipt.blockNumber + 1 < config.confirmations) {
        if(i+1 < (config.receiptPollAttempts ?? 3)){await sleep(config.pollMs ?? 2000);continue;}
        return { status: 'broadcast-uncertain', hash: entry.hash, amountMicro: entry.amountMicro };
      }
      if (receipt.status !== 1) {
        entry.status = 'reverted'; store.save(journal);
        throw new Error('Topup transaction reverted; retained for manual review');
      }
      const matches = receipt.logs.filter((log) => {
        const e = transfer(log);
        return e && e.from === journal.identity.seller && e.to === entry.receiver && e.amount === BigInt(entry.amountMicro) && log.transactionHash === entry.hash;
      });
      if (matches.length !== 1) throw new Error('Receipt lacks exact native-USDC topup Transfer');
      if (entry.status !== 'credit-observed') { entry.status = 'mined'; store.save(journal); }
      for (let j = 0; j < (config.creditPollAttempts ?? 5); j++) {
        const b = balanceTotals(await api.balance());
        if (b.pending === 0n && b.spendable >= BigInt(entry.preSpendableMicro) + BigInt(entry.amountMicro)) {
          entry.status = 'credit-observed'; store.save(journal);
          return { status: 'credit-observed', hash: entry.hash, amountMicro: entry.amountMicro, confirmation: 'observed-spendable-balance-increase' };
        }
        if (j + 1 < (config.creditPollAttempts ?? 5)) await sleep(config.pollMs ?? 2000);
      }
      return { status: 'mined-awaiting-credit', hash: entry.hash, amountMicro: entry.amountMicro };
    }
    if (i + 1 < (config.receiptPollAttempts ?? 3)) await sleep(config.pollMs ?? 2000);
  }
  return { status: 'broadcast-uncertain', hash: entry.hash, amountMicro: entry.amountMicro };
}

/** Dry-run by default. Adapters are ethers-compatible RPC/signer and authenticated SI API.
 * Keep the same private state directory forever; deleting it loses the anti-replay ledger.
 */
export async function executeTopup(config, adapters) {
  const store = lockedStore(config.stateDir);
  try {
    integer(config.startBlock, 'initial block checkpoint');
    const confirmations = integer(config.confirmations ?? 12, 'confirmations', 1);
    config = { ...config, confirmations };
    for (const field of ['receiptPollAttempts', 'creditPollAttempts']) if (config[field] !== undefined) integer(config[field], field, 1);
    if (config.pollMs !== undefined) integer(config.pollMs, 'pollMs');
    if (!Array.isArray(config.payoutContracts) || !config.payoutContracts.length) throw new Error('Verified payout contracts required');
    const { provider, signer, api } = adapters;
    if ((await provider.getNetwork()).chainId !== 8453n) throw new Error('RPC must be Base chain 8453');
    const seller = address(await signer.getAddress());
    const payoutContracts = [...new Set(config.payoutContracts.map(address))].sort();
    for (const contract of payoutContracts) if ((await provider.getCode(contract)) === '0x') throw new Error('Payout address is not a deployed contract');
    const checkpoint = await provider.getBlock(config.startBlock);
    if (!checkpoint?.hash) throw new Error('Checkpoint block unavailable');
    const identity = { chainId: BASE_CHAIN_ID, token: USDC, seller, payoutContracts, startBlock: config.startBlock, checkpointHash: checkpoint.hash };
    let journal = store.load();
    if (!journal) { journal = { version: 1, identity, entries: [] }; store.save(journal); }
    if (journal.version !== 1 || JSON.stringify(journal.identity) !== JSON.stringify(identity) || !Array.isArray(journal.entries)) throw new Error('Journal identity/checkpoint mismatch');
    for (const entry of journal.entries) validateEntry(entry, identity);
    if (new Set(journal.entries.map((e) => e.hash)).size !== journal.entries.length || new Set(journal.entries.map((e) => e.nonce)).size !== journal.entries.length) throw new Error('Duplicate journal entry');
    const unresolved = journal.entries.filter((e) => e.status !== 'credit-observed');
    if (unresolved.length > 1) throw new Error('Multiple unresolved journal entries');
    let entry = unresolved[0];
    if (entry && entry.status !== 'prepared') return await reconcile(entry, journal, store, config, adapters);
    const initialNonce = config.execute && !entry ? await provider.getTransactionCount(seller, 'pending') : undefined;
    const head = await provider.getBlockNumber();
    const confirmedBlock = head - confirmations + 1;
    if (config.startBlock > confirmedBlock) throw new Error('Checkpoint is not confirmed');
    const revenue = await scanRevenue(provider, identity, confirmedBlock, head, journal.entries);
    const balance = await api.balance();
    const funds = await walletFunds(provider, seller);
    const now = (adapters.now ?? (() => new Date()))();
    const day = now.toISOString().slice(0, 10);
    const committed = journal.entries.filter((e) => e !== entry);
    const totals = {
      alreadySentMicro: String(committed.reduce((a, e) => a + uint(e.amountMicro), 0n)),
      sentTodayMicro: String(committed.filter((e) => (e.attemptedAt ?? e.createdAt).slice(0, 10) === day).reduce((a, e) => a + uint(e.amountMicro), 0n)),
    };
    const baseInput = { balance, revenueMicro: String(revenue), ...totals, ...funds, gasCostWei: '0', policy: config.policy };
    let plan = planTopup(baseInput);
    if (plan.amountMicro === '0') return { ...plan, status: 'no-topup' };
    const deposit = validateDeposit(await api.depositAddress());
    if (deposit.address === seller) throw new Error('Deposit receiver must not be seller');
    if (entry && (entry.receiver !== deposit.address || entry.amountMicro !== plan.amountMicro)) throw new Error('Prepared intent no longer matches safe current plan');
    const transaction = { from: seller, to: USDC, value: 0n, data: erc20.encodeFunctionData('transfer', [deposit.address, plan.amountMicro]) };
    const fee = await fees(provider, config.policy, transaction);
    plan = planTopup({ ...baseInput, gasCostWei: String(fee.gasCost) });
    if (!config.execute) return { ...plan, status: 'dry-run', seller, receiver: deposit.address, confirmedThroughBlock: confirmedBlock };
    if (!entry) {
      const nonce = initialNonce;
      integer(nonce, 'nonce');
      const rawTransaction = await signer.signTransaction({ to: USDC, value: 0n, data: transaction.data, type: 2, chainId: 8453, nonce,
        gasLimit: fee.gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
      entry = { status: 'prepared', rawTransaction, hash: keccak256(rawTransaction), nonce, receiver: deposit.address,
        amountMicro: plan.amountMicro, createdAt: now.toISOString(), preSpendableMicro: String(balanceTotals(balance).spendable) };
      validateEntry(entry, identity);
      journal.entries.push(entry); store.save(journal);
    }
    const signed = validateEntry(entry, identity);
    if (signed.maxFeePerGas > uint(config.policy.maxFeePerGasWei) || signed.gasLimit * signed.maxFeePerGas + uint(config.policy.l1FeeReserveWei ?? '0') > uint(config.policy.maxGasCostWei)) throw new Error('Prepared gas fee exceeds current guard');
    const finalDeposit = validateDeposit(await api.depositAddress());
    if (finalDeposit.address !== entry.receiver) throw new Error('Deposit address changed before send');
    if ((await provider.getNetwork()).chainId !== 8453n) throw new Error('RPC changed away from Base');
    const freshBalance = await api.balance();
    const finalFunds = await walletFunds(provider, seller);
    if (await provider.getTransactionCount(seller, 'pending') !== entry.nonce) throw new Error('Signer nonce changed; reconcile exact prepared hash manually');
    const attemptTime = (adapters.now ?? (() => new Date()))().toISOString();
    const actualDay = attemptTime.slice(0, 10);
    const actualTodayMicro = String(committed.filter((e) => (e.attemptedAt ?? e.createdAt).slice(0, 10) === actualDay).reduce((a, e) => a + uint(e.amountMicro), 0n));
    const finalPlan = planTopup({ ...baseInput, sentTodayMicro: actualTodayMicro, balance: freshBalance, ...finalFunds, gasCostWei: String(signed.gasLimit * signed.maxFeePerGas + uint(config.policy.l1FeeReserveWei ?? '0')) });
    if (BigInt(finalPlan.amountMicro) < BigInt(entry.amountMicro)) throw new Error('Final plan no longer funds signed topup');
    // No await between exact persisted-journal/lock authorization and actual send.
    store.assert();
    entry.status = 'broadcast-uncertain'; entry.attemptedAt = attemptTime; store.save(journal); store.assert();
    try { await provider.broadcastTransaction(entry.rawTransaction); }
    catch { /* Never leak RPC errors containing raw signed bytes; reconcile only this hash. */ }
    return await reconcile(entry, journal, store, config, adapters);
  } finally { store.close(); }
}
