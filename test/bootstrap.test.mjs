import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Wallet, Interface } from 'ethers';

const module = await import('../lib/bootstrap.mjs').catch(() => ({}));
const wallet = new Wallet('0x' + '11'.repeat(32)); // Synthetic offline identity only.
const token = new Interface(['function balanceOf(address) view returns(uint256)']);
async function fixture(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR, 'bootstrap-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { STATE_DIR: dir, ANTSEED_PRIVATE_KEY: wallet.privateKey, SURPLUS_API_KEY: 'inf_offline_fixture' };
  const reads = [];
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }),
    getBlockNumber: async () => 100,
    getBalance: async (address) => { assert.equal(address, wallet.address); reads.push('eth'); return 123n; },
    call: async (tx) => { assert.equal(token.decodeFunctionData('balanceOf', tx.data)[0], wallet.address); reads.push('usdc'); return token.encodeFunctionResult('balanceOf', [456n]); },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.surplusintelligence.ai/v1/payments/balance');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    reads.push('credit');
    return { ok: true, json: async () => ({ credit_balance_usdc: '789', usdc_available_usdc: '0', pending_deposit_usdc: '0' }) };
  };
  const options = { env, provider, fetchImpl, now: () => new Date('2026-10-28T00:00:00.000Z') };
  return { dir, env, provider, fetchImpl, options, reads };
}

test('setup reads balances and creates a private confirmed checkpoint without pricing consent or spending', async (t) => {
  assert.equal(typeof module.bootstrap, 'function', 'missing read-only bootstrap');
  const f = await fixture(t);
  const result = await module.bootstrap(f.options);
  assert.equal(result.seller, wallet.address);
  assert.deepEqual(result.balances, { ethWei: '123', nativeUsdcMicro: '456', surplusCreditMicro: '789', surplusPendingMicro: '0' });
  assert.deepEqual(f.reads.sort(), ['credit', 'eth', 'usdc']);
  const file = join(f.dir, 'revenue-checkpoint.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { chainId: 8453, startBlock: 88, payoutContracts: ['0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2'], createdAt: '2026-10-28T00:00:00.000Z' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  await assert.rejects(readFile(join(f.dir, 'pricing-policy.json')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes(wallet.privateKey), false);
  assert.equal(JSON.stringify(result).includes(f.env.SURPLUS_API_KEY), false);
});

test('setup preserves checkpoint bytes across repeated runs and refuses changed seller identity', async (t) => {
  const f = await fixture(t);
  await module.bootstrap(f.options);
  const file = join(f.dir, 'revenue-checkpoint.json');
  const original = await readFile(file, 'utf8');
  f.provider.getBlockNumber = async () => 200;
  await module.bootstrap(f.options);
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(module.bootstrap({ ...f.options, env: { ...f.env, ANTSEED_PRIVATE_KEY: '0x' + '22'.repeat(32) } }), /identity/i);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('estimated pricing policy is created only with explicit expiring consent', async (t) => {
  const f = await fixture(t);
  const result = await module.bootstrap({ ...f.options, acceptEstimatedPricing: true });
  const policy = JSON.parse(await readFile(result.pricingPolicyFile, 'utf8'));
  assert.deepEqual(policy, {
    version: 1, allowEstimates: true, provider: 'groq', cacheAtInput: true, referenceFallback: true,
    reviewedAt: '2026-10-28T00:00:00.000Z', expiresAt: '2026-10-29T00:00:00.000Z',
    sourceRevision: '2207d607e747f487a4d83e60c7f24ad677a55a7f', feeCushionBps: 1000, offerMultiplierCeiling: 2,
  });
  assert.equal((await stat(result.pricingPolicyFile)).mode & 0o777, 0o600);
  const bytes = await readFile(result.pricingPolicyFile, 'utf8');
  await module.bootstrap({ ...f.options, now: () => new Date('2026-10-28T12:00:00.000Z') });
  assert.equal(await readFile(result.pricingPolicyFile, 'utf8'), bytes, 'no implicit policy renewal');
});

test('setup refuses wrong chain or invalid balances before creating the checkpoint', async (t) => {
  const f = await fixture(t);
  f.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(module.bootstrap(f.options), /Base|chain/i);
  await assert.rejects(readFile(join(f.dir, 'revenue-checkpoint.json')), { code: 'ENOENT' });
  f.provider.getNetwork = async () => ({ chainId: 8453n });
  f.options.fetchImpl = async () => ({ ok: true, json: async () => ({ credit_balance_usdc: '-1' }) });
  await assert.rejects(module.bootstrap(f.options), /balance/i);
  await assert.rejects(readFile(join(f.dir, 'revenue-checkpoint.json')), { code: 'ENOENT' });
});

test('wallet generation requires opt-in, never overwrites an existing wallet, and writes privately', async (t) => {
  const f = await fixture(t);
  delete f.env.ANTSEED_PRIVATE_KEY;
  await assert.rejects(module.bootstrap(f.options), /wallet|PRIVATE_KEY/i);
  // Generated identities vary; balance reads remain strictly read-only.
  f.provider.getBalance = async () => 0n;
  f.provider.call = async () => token.encodeFunctionResult('balanceOf', [0n]);
  const result = await module.bootstrap({ ...f.options, generateWallet: true });
  const saved = JSON.parse(await readFile(result.walletFile, 'utf8'));
  assert.equal(new Wallet(saved.private_key).address, result.seller);
  assert.equal((await stat(result.walletFile)).mode & 0o777, 0o600);
  const bytes = await readFile(result.walletFile, 'utf8');
  await module.bootstrap({ ...f.options, generateWallet: true });
  assert.equal(await readFile(result.walletFile, 'utf8'), bytes);
  assert.equal(JSON.stringify(result).includes(saved.private_key), false);
});

test('setup refuses checkpoint replacement, public permissions, symlinks and preexisting treasury without checkpoint', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'topup-journal.json'), '{}', { mode: 0o600 });
  await assert.rejects(module.bootstrap(f.options), /journal|checkpoint/i);
  await rm(join(f.dir, 'topup-journal.json'));
  await module.bootstrap(f.options);
  const file = join(f.dir, 'revenue-checkpoint.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...original, payoutContracts: [wallet.address] }));
  await assert.rejects(module.bootstrap(f.options), /checkpoint/i);
  await writeFile(file, JSON.stringify(original));
  await chmod(file, 0o644);
  await assert.rejects(module.bootstrap(f.options), /private|0600/i);
  await chmod(file, 0o600);
  const other = join(f.dir, 'other.json');
  await writeFile(other, JSON.stringify(original), { mode: 0o600 });
  await rm(file);
  await symlink(other, file);
  await assert.rejects(module.bootstrap(f.options), /private|regular|symlink/i);
});

test('setup adopts a legacy checkpoint without changing bytes and validates existing treasury identity', async (t) => {
  const f = await fixture(t);
  const checkpoint = { chainId: 8453, startBlock: 70, payoutContracts: ['0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2'], createdAt: '2026-10-27T00:00:00.000Z' };
  const checkpointFile = join(f.dir, 'revenue-checkpoint.json');
  const bytes = JSON.stringify(checkpoint) + '\n';
  await writeFile(checkpointFile, bytes, { mode: 0o600 });
  const journalFile = join(f.dir, 'topup-journal.json');
  await writeFile(journalFile, JSON.stringify({ version: 1, identity: { chainId: 8453, seller: wallet.address, startBlock: 70, payoutContracts: checkpoint.payoutContracts }, entries: [] }), { mode: 0o600 });
  await module.bootstrap(f.options);
  assert.equal(await readFile(checkpointFile, 'utf8'), bytes);
  await rm(join(f.dir, 'bootstrap-identity.json'));
  await writeFile(journalFile, JSON.stringify({ version: 1, identity: { chainId: 8453, seller: '0x2222222222222222222222222222222222222222', startBlock: 70, payoutContracts: checkpoint.payoutContracts }, entries: [] }));
  await assert.rejects(module.bootstrap(f.options), /identity/i);
  assert.equal(await readFile(checkpointFile, 'utf8'), bytes);
});

test('generating an external wallet does not change permissions of its parent directory', async (t) => {
  const f = await fixture(t);
  const external = await mkdtemp(join(process.env.TMPDIR, 'bootstrap-wallet-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await chmod(external, 0o755);
  delete f.env.ANTSEED_PRIVATE_KEY;
  f.env.ANTSEED_WALLET_FILE = join(external, 'wallet.json');
  f.provider.getBalance = async () => 0n;
  f.provider.call = async () => token.encodeFunctionResult('balanceOf', [0n]);
  await module.bootstrap({ ...f.options, generateWallet: true });
  assert.equal((await stat(external)).mode & 0o777, 0o755);
});

test('legacy checkpoints without createdAt remain usable without changing bytes', async (t) => {
  const f = await fixture(t);
  const file = join(f.dir, 'revenue-checkpoint.json');
  const bytes = JSON.stringify({ chainId: 8453, startBlock: 70, payoutContracts: ['0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2'] });
  await writeFile(file, bytes, { mode: 0o600 });
  await module.bootstrap(f.options);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('external policy consent does not change its parent directory permissions', async (t) => {
  const f = await fixture(t);
  const external = await mkdtemp(join(process.env.TMPDIR, 'bootstrap-policy-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await chmod(external, 0o755);
  f.env.PRICING_POLICY_FILE = join(external, 'policy.json');
  await module.bootstrap({ ...f.options, acceptEstimatedPricing: true });
  assert.equal((await stat(external)).mode & 0o777, 0o755);
});

test('setup env loading and CLI flags are strict, private and preserve environment precedence', async (t) => {
  assert.equal(typeof module.parseSetupArgs, 'function', 'missing setup argument parser');
  const f = await fixture(t);
  const file = join(f.dir, 'config.env');
  await writeFile(file, 'MODELS=openai-gpt-oss-120b\nMARGIN_BPS=500\n', { mode: 0o600 });
  assert.equal((await module.loadSetupEnv(file, { MARGIN_BPS: '600' }, true)).MARGIN_BPS, '600');
  await chmod(file, 0o644);
  await assert.rejects(module.loadSetupEnv(file, {}, true), /0600|private/);
  assert.deepEqual(module.parseSetupArgs(['--env', file, '--generate-wallet', '--accept-estimated-pricing']), { envFile: file, explicitEnv: true, generateWallet: true, acceptEstimatedPricing: true, help: false });
  assert.throws(() => module.parseSetupArgs(['--execute']), /Unknown/);
  assert.throws(() => module.parseSetupArgs(['--env']), /requires/);
});
