#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { JsonRpcProvider, FetchRequest, Wallet } from 'ethers';
import { executeTopup } from '../lib/topup.mjs';

const HELP = `Revenue-funded Surplus topup (dry-run by default)
Usage: node scripts/topup.mjs [--env FILE] [--execute]

Required: ANTSEED_WALLET_FILE (private JSON private_key) or ANTSEED_PRIVATE_KEY;
SURPLUS_API_KEY or SURPLUS_API_KEY_FILE (raw or dotenv); TOPUP_START_BLOCK;
ANTSEED_PAYOUT_CONTRACTS (comma-separated independently verified current contracts).
ANTSEED_BASE_RPC_URL defaults to https://mainnet.base.org.

All TOPUP_*_MICRO values are integer native USDC micros (1000000 = 1 USDC).
TOPUP_THRESHOLD_MICRO=200000 TOPUP_TARGET_MICRO=1000000
TOPUP_MAX_MICRO=1000000 TOPUP_DAILY_CAP_MICRO=1000000
TOPUP_WALLET_RESERVE_MICRO=0 TOPUP_ETH_RESERVE_WEI=100000000000000
TOPUP_MAX_FEE_PER_GAS_WEI=100000000 TOPUP_MAX_GAS_COST_WEI=50000000000000
TOPUP_L1_FEE_RESERVE_WEI=10000000000000 TOPUP_CONFIRMATIONS=12
STATE_DIR=.state. Preserve this private journal; inspect stale locks manually.
Only --execute authorizes signing/sending; TOPUP_EXECUTE is deliberately ignored.
Never change the initial block checkpoint after initializing the ledger.
`;
function numberEnv(env, name, fallback, min = 0) {
  const value = env[name] ?? fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new Error(`Invalid ${name}`);
  return Number(value);
}
function units(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}: expected integer base units`);
  return value;
}
export function topupConfig(env = process.env, execute = false) {
  let checkpoint;
  if(!env.TOPUP_START_BLOCK || !env.ANTSEED_PAYOUT_CONTRACTS) {
    try {checkpoint=JSON.parse(readFileSync(resolve(env.STATE_DIR ?? '.state','revenue-checkpoint.json'),'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw new Error('Invalid revenue checkpoint');}
    if(checkpoint && (checkpoint.chainId!==8453 || !Number.isSafeInteger(checkpoint.startBlock) || checkpoint.startBlock<0 || !Array.isArray(checkpoint.payoutContracts)))throw new Error('Invalid revenue checkpoint');
  }
  const maxMicro = units(env, 'TOPUP_MAX_MICRO', '1000000');
  if (BigInt(maxMicro) > 1000000n) throw new Error('Topup maximum cannot exceed one USDC per transaction');
  return {
    stateDir: resolve(env.STATE_DIR ?? '.state'), execute: execute === true,
    startBlock: numberEnv(env, 'TOPUP_START_BLOCK', checkpoint ? String(checkpoint.startBlock) : undefined),
    payoutContracts: env.ANTSEED_PAYOUT_CONTRACTS ? env.ANTSEED_PAYOUT_CONTRACTS.split(',').map((s) => s.trim()).filter(Boolean) : checkpoint?.payoutContracts ?? [],
    confirmations: numberEnv(env, 'TOPUP_CONFIRMATIONS', '12', 1),
    receiptPollAttempts: numberEnv(env, 'TOPUP_RECEIPT_POLL_ATTEMPTS', '15', 1),
    creditPollAttempts: numberEnv(env, 'TOPUP_CREDIT_POLL_ATTEMPTS', '15', 1),
    pollMs: numberEnv(env, 'TOPUP_POLL_MS', '2000', 0),
    policy: {
      thresholdMicro: units(env, 'TOPUP_THRESHOLD_MICRO', '200000'),
      targetMicro: units(env, 'TOPUP_TARGET_MICRO', '1000000'), maxMicro,
      dailyCapMicro: units(env, 'TOPUP_DAILY_CAP_MICRO', '1000000'),
      walletReserveMicro: units(env, 'TOPUP_WALLET_RESERVE_MICRO', '0'),
      ethReserveWei: units(env, 'TOPUP_ETH_RESERVE_WEI', '100000000000000'),
      maxFeePerGasWei: units(env, 'TOPUP_MAX_FEE_PER_GAS_WEI', '100000000'),
      maxGasCostWei: units(env, 'TOPUP_MAX_GAS_COST_WEI', '50000000000000'),
      l1FeeReserveWei: units(env, 'TOPUP_L1_FEE_RESERVE_WEI', '10000000000000'),
    },
  };
}
function secretFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Credential file must be a private regular file (0600)');
  return readFileSync(path, 'utf8').trim();
}
export function credentials(env) {
  let privateKey = env.ANTSEED_PRIVATE_KEY;
  if (!privateKey && env.ANTSEED_WALLET_FILE) {
    const text = secretFile(env.ANTSEED_WALLET_FILE);
    let data;try { data=JSON.parse(text); } catch { throw new Error('Wallet must be JSON with private_key/privateKey'); }
    privateKey=data.private_key ?? data.privateKey;
    if(data.address && new Wallet(privateKey).address.toLowerCase()!==data.address.toLowerCase())throw Error('Seller wallet address mismatch');
  }
  if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Set ANTSEED_PRIVATE_KEY or ANTSEED_WALLET_FILE');
  let apiKey = env.SURPLUS_API_KEY;
  if (!apiKey && env.SURPLUS_API_KEY_FILE) {
    const text = secretFile(env.SURPLUS_API_KEY_FILE);
    apiKey = parseEnv(text).SURPLUS_API_KEY ?? text;
  }
  if (typeof apiKey !== 'string' || !/^inf_[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.startsWith('inf_admin_')) throw new Error('Set an inference SURPLUS_API_KEY or SURPLUS_API_KEY_FILE');
  return { privateKey, apiKey };
}
function surplusApi(apiKey) {
  const get = async (endpoint) => {
    let response;
    try {
      response = await fetch(`https://api.surplusintelligence.ai/v1/payments/${endpoint}`, {
        method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('Surplus payment API network failure'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Surplus payment API HTTP ${response.status}`); }
    let result;
    try { result = await response.json(); } catch { throw new Error('Surplus payment API returned invalid JSON'); }
    return result;
  };
  return { balance: () => get('balance'), depositAddress: () => get('deposit-address') };
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  let execute = false, envFile = '.env', explicitEnv = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') execute = true;
    else if (argv[i] === '--env') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--env requires a file');
      envFile = argv[++i]; explicitEnv = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); return; }
    else throw new Error('Unknown argument; use --help');
  }
  try {
    const parsed = parseEnv(secretFile(envFile));
    env = { ...parsed, ...env }; // Existing process environment takes precedence.
  } catch (e) {
    if (e.code !== 'ENOENT' || explicitEnv) throw new Error('Cannot load private env file (must exist and have mode 0600)');
  }
  const config = topupConfig(env, execute);
  if (!config.payoutContracts.length) throw new Error('ANTSEED_PAYOUT_CONTRACTS must contain verified payout contracts');
  const { privateKey, apiKey } = credentials(env);
  const rpcUrl = env.ANTSEED_BASE_RPC_URL ?? 'https://mainnet.base.org';
  let url;
  try { url = new URL(rpcUrl); } catch { throw new Error('Invalid Base RPC URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('RPC must use HTTPS or loopback HTTP');
  const request = new FetchRequest(rpcUrl); request.timeout = 15000;
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  try {
    const result = await executeTopup(config, { provider, signer: new Wallet(privateKey), api: surplusApi(apiKey) });
    console.log(JSON.stringify(result, null, 2));
    if (['broadcast-uncertain', 'mined-awaiting-credit'].includes(result.status)) process.exitCode = 2;
    return result;
  } finally { provider.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // JSON/RPC errors may contain credentials or replayable signed bytes. Do not print stacks.
    const message = error?.code ? 'Operation failed; inspect private journal and RPC availability' : String(error?.message ?? 'Topup failed');
    const safe = message.replace(/inf_[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/0x[0-9a-fA-F]{64,}/g, '[REDACTED]').replace(/https?:\/\/[^\s"']+/g, '[URL REDACTED]');
    console.error(`Topup stopped: ${safe}`);
    process.exitCode = 1;
  });
}
