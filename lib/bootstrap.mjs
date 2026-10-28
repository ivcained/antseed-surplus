import { readFile, lstat, mkdir, chmod, open, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { Wallet, JsonRpcProvider, FetchRequest, Interface } from 'ethers';
import { readSellerWallet } from './runtime.mjs';
import { readCredential } from './settings.mjs';

const PAYOUT = '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const token = new Interface(['function balanceOf(address) view returns(uint256)']);

async function privateText(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Expected private regular file (0600)');
  return readFile(file, 'utf8');
}
async function optionalJson(file) {
  try { return JSON.parse(await privateText(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('State directory must not be a symlink');
  await chmod(dir, 0o700);
}
async function exclusiveJson(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  const dir = await open(dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  if (await privateText(file) !== text) throw new Error('Setup persistence readback failed');
}
export function parseSetupArgs(argv) {
  const result = { envFile: '.env', explicitEnv: false, generateWallet: false, acceptEstimatedPricing: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--env requires a file');
      result.envFile = argv[++i]; result.explicitEnv = true;
    } else if (argv[i] === '--generate-wallet') result.generateWallet = true;
    else if (argv[i] === '--accept-estimated-pricing') result.acceptEstimatedPricing = true;
    else if (argv[i] === '--help' || argv[i] === '-h') result.help = true;
    else throw new Error('Unknown argument; use --help');
  }
  return result;
}
export async function loadSetupEnv(file, env = process.env, explicit = false) {
  try { return { ...parseEnv(await privateText(file)), ...env }; }
  catch (error) {
    if (error.code === 'ENOENT' && !explicit) return { ...env };
    throw new Error('Cannot load private env file (must exist and have mode 0600)');
  }
}
function unsigned(value) { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value); }
function confirmations(env) {
  const value = env.TOPUP_CONFIRMATIONS ?? '12';
  if (!unsigned(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('Invalid TOPUP_CONFIRMATIONS');
  return Number(value);
}
function rpcProvider(env) {
  const url = new URL(env.ANTSEED_BASE_RPC_URL ?? 'https://mainnet.base.org');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC must use HTTPS or loopback HTTP');
  const request = new FetchRequest(url.href); request.timeout = 15000;
  return new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
}

/** Read-only network bootstrap. No registration, stake, signing, or transfer. */
export async function bootstrap({ env = process.env, generateWallet = false, acceptEstimatedPricing = false, provider, fetchImpl = fetch, now = () => new Date() } = {}) {
  const stateDir = resolve(env.STATE_DIR ?? '.state');
  const depth = confirmations(env);
  await privateDirectory(stateDir);
  const lockPath = join(stateDir, 'setup.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Setup lock exists; inspect prior setup before manual removal'); });
  let ownProvider;
  try {
    env = { ...env };
    let walletFile = env.ANTSEED_WALLET_FILE ? resolve(env.ANTSEED_WALLET_FILE) : undefined;
    if (!env.ANTSEED_PRIVATE_KEY) {
      if (!walletFile && generateWallet) walletFile = join(stateDir, 'seller-wallet.json');
      if (!walletFile) throw new Error('Set ANTSEED_WALLET_FILE or ANTSEED_PRIVATE_KEY; wallet generation requires --generate-wallet');
      try { await privateText(walletFile); }
      catch (error) {
        if (error.code !== 'ENOENT' || !generateWallet) throw error;
        await mkdir(dirname(walletFile), { recursive: true, mode: 0o700 });
        const wallet = Wallet.createRandom();
        await exclusiveJson(walletFile, { address: wallet.address, private_key: wallet.privateKey });
      }
      env.ANTSEED_WALLET_FILE = walletFile;
    }
    const wallet = await readSellerWallet(env);
    if (!env.SURPLUS_API_KEY && env.SURPLUS_API_KEY_FILE) await privateText(env.SURPLUS_API_KEY_FILE);
    const key = await readCredential(env);
    if (!/^inf_[A-Za-z0-9_-]+$/.test(key) || key.startsWith('inf_admin_')) throw new Error('Expected inference credential');

    const checkpointFile = join(stateDir, 'revenue-checkpoint.json');
    const identityFile = join(stateDir, 'bootstrap-identity.json');
    const existing = await optionalJson(checkpointFile);
    const identity = await optionalJson(identityFile);
    if (identity && identity.seller !== wallet.address) throw new Error('Bootstrap seller identity changed; preserve the original treasury');
    if (identity && !existing) throw new Error('Incomplete checkpoint identity; manual treasury inspection required');
    if (existing && (existing.chainId !== 8453 || !Number.isSafeInteger(existing.startBlock) || existing.startBlock < 0 || JSON.stringify(existing.payoutContracts) !== JSON.stringify([PAYOUT]) || (existing.createdAt !== undefined && !Number.isFinite(Date.parse(existing.createdAt))) || (identity && JSON.stringify(identity.checkpoint) !== JSON.stringify(existing)))) throw new Error('Revenue checkpoint changed or invalid');
    const journal = await optionalJson(join(stateDir, 'topup-journal.json'));
    if (journal && !existing) throw new Error('Existing treasury journal without checkpoint; refusing reset');
    if (journal && (journal.identity?.seller?.toLowerCase() !== wallet.address.toLowerCase() || journal.identity?.chainId !== 8453 || journal.identity?.startBlock !== existing.startBlock || JSON.stringify(journal.identity?.payoutContracts?.map((value) => value.toLowerCase())) !== JSON.stringify(existing.payoutContracts.map((value) => value.toLowerCase())))) throw new Error('Existing treasury journal identity/checkpoint mismatch');
    provider ??= (ownProvider = rpcProvider(env));
    if (BigInt((await provider.getNetwork()).chainId) !== 8453n) throw new Error('RPC must use Base chain 8453');
    const head = await provider.getBlockNumber();
    const confirmed = head - depth;
    if (!Number.isSafeInteger(confirmed) || confirmed < 0 || (existing && confirmed < existing.startBlock)) throw new Error('Invalid confirmed chain head/checkpoint');
    const response = await fetchImpl('https://api.surplusintelligence.ai/v1/payments/balance', { method: 'GET', headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Surplus balance unavailable'); }
    const balance = await response.json();
    if (!['credit_balance_usdc', 'usdc_available_usdc', 'pending_deposit_usdc'].every((field) => unsigned(balance?.[field]))) throw new Error('Invalid Surplus balance');
    const eth = await provider.getBalance(wallet.address);
    const [usdc] = token.decodeFunctionResult('balanceOf', await provider.call({ to: USDC, data: token.encodeFunctionData('balanceOf', [wallet.address]) }));
    if (typeof eth !== 'bigint' || eth < 0n) throw new Error('Invalid ETH balance');
    const stamp = now();
    if (!(stamp instanceof Date) || !Number.isFinite(stamp.getTime())) throw new Error('Invalid setup time');
    const checkpoint = existing ?? { chainId: 8453, startBlock: confirmed, payoutContracts: [PAYOUT], createdAt: stamp.toISOString() };
    if (!identity) await exclusiveJson(identityFile, { version: 1, seller: wallet.address, checkpoint });
    if (!existing) await exclusiveJson(checkpointFile, checkpoint);
    const pricingPolicyFile = resolve(env.PRICING_POLICY_FILE ?? join(stateDir, 'pricing-policy.json'));
    if (acceptEstimatedPricing) {
      // Explicit operator consent only; never renew a policy in the monitor.
      await mkdir(dirname(pricingPolicyFile), { recursive: true, mode: 0o700 });
      const policy = { version: 1, allowEstimates: true, provider: 'groq', cacheAtInput: true, referenceFallback: true, reviewedAt: stamp.toISOString(), expiresAt: new Date(stamp.getTime() + 86400000).toISOString(), sourceRevision: '2207d607e747f487a4d83e60c7f24ad677a55a7f', feeCushionBps: 1000, offerMultiplierCeiling: 2 };
      // First consent creates the policy. Renewal is deliberately a separate
      // operator action (move the expired file aside, rerun with this flag).
      await exclusiveJson(pricingPolicyFile, policy);
    }
    return { seller: wallet.address, ...(walletFile ? { walletFile } : {}), checkpointFile, checkpoint, ...(acceptEstimatedPricing ? { pricingPolicyFile } : {}), balances: { ethWei: String(eth), nativeUsdcMicro: String(usdc), surplusCreditMicro: balance.credit_balance_usdc, surplusPendingMicro: balance.pending_deposit_usdc } };
  } finally {
    ownProvider?.destroy();
    await lock.close(); await unlink(lockPath);
  }
}
