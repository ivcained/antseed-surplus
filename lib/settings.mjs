import { readFile, lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {lstatSync} from 'node:fs';

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw)<min || Number(raw)>max) throw new Error(`Invalid ${name}`);
  return Number(raw);
}
export async function loadSettings(env=process.env) {
  const surplusBaseUrl = env.SURPLUS_BASE_URL ?? 'https://api.surplusintelligence.ai/v1';
  const url = new URL(surplusBaseUrl);
  if (url.origin !== 'https://api.surplusintelligence.ai' || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) throw new Error('Untrusted Surplus origin');
  const models = (env.MODELS ?? 'openai-gpt-oss-120b').split(',').map(s=>s.trim());
  if (!models.length || models.some(s=>!s || !/^[a-zA-Z0-9_.:/-]+$/.test(s))) throw new Error('Invalid MODELS');
  const lossTest=env.LOSS_TEST==='true';
  const lossUntil=Date.parse(env.LOSS_TEST_UNTIL ?? '');
  const lossMaxRequests=integer(env,'LOSS_TEST_MAX_REQUESTS',0,0,100);
  const pricingPolicy=env.PRICING_POLICY_FILE ? JSON.parse(await readFile(env.PRICING_POLICY_FILE,'utf8')) : undefined;
  if(lossTest && (!Number.isFinite(lossUntil) || lossUntil<=Date.now() || lossUntil>Date.now()+3600_000 || lossMaxRequests<1)) throw new Error('LOSS_TEST requires expiry within one hour and 1-100 requests');
  return {
    surplusBaseUrl: surplusBaseUrl.replace(/\/$/,''), models,
    marginBps:integer(env,'MARGIN_BPS',500,0,9999), pricingPolicy,
    safetyBps:integer(env,'SAFETY_BPS',500,0,9999),
    antseedFeeBps:integer(env,'ANTSEED_FEE_BPS',400,0,9999),
    stateDir:resolve(env.STATE_DIR ?? '.state'),
    rpcUrl:env.ANTSEED_BASE_RPC_URL ?? 'https://base.gateway.tenderly.co',
    publicAddress:env.ANTSEED_PUBLIC_ADDRESS ?? '',
    gatewayPort:integer(env,'GATEWAY_PORT',18791,1024,65535),
    dhtPort:integer(env,'DHT_PORT',6881,1024,65535),
    signalingPort:integer(env,'SIGNALING_PORT',6882,1024,65535),
    maxConcurrent:integer(env,'MAX_CONCURRENT',2,1,50),
    quoteMaxAgeMs:integer(env,'QUOTE_MAX_AGE_SECONDS',300,10,3600)*1000,
    refreshMs:integer(env,'PRICE_REFRESH_SECONDS',120,10,1800)*1000,
    maxTokens:integer(env,'MAX_OUTPUT_TOKENS',4096,1,32768),
    maxInputBytes:integer(env,'MAX_INPUT_BYTES',131072,1024,2097152),
    executeTopup:env.TOPUP_EXECUTE==='true', lossTest,lossUntil,lossMaxRequests,
    lossPriceFactor: lossTest ? 0.1 : 1,
  };
}
export async function privateDirectory(path) { await mkdir(path,{recursive:true,mode:0o700}); }
export async function readCredential(env=process.env) {
  if(env.SURPLUS_API_KEY) {
    if(!/^inf_[A-Za-z0-9_-]+$/.test(env.SURPLUS_API_KEY) || env.SURPLUS_API_KEY.startsWith('inf_admin_'))throw new Error('Expected inference credential');
    return env.SURPLUS_API_KEY;
  }
  if(!env.SURPLUS_API_KEY_FILE) throw new Error('Set SURPLUS_API_KEY or SURPLUS_API_KEY_FILE');
  const file=env.SURPLUS_API_KEY_FILE;
  const info=await lstat(file);
  if(!info.isFile() || info.isSymbolicLink())throw new Error('Credential must be a private regular file');
  if(info.mode & 0o077) throw new Error('Credential file permissions must be 0600');
  const content=(await readFile(file,'utf8')).trim();
  const entry=content.match(/^(?:export\s+)?SURPLUS_API_KEY\s*=\s*(.+)$/m);
  const key=(entry ? entry[1].trim().replace(/^(["'])(.*)\1$/,'$2') : content).trim();
  if(!/^inf_[A-Za-z0-9_-]+$/.test(key) || key.startsWith('inf_admin_')) throw new Error('Expected inference credential');
  return key;
}
export function redactError(error) {
  return String(error?.message ?? error).replace(/inf_[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/0x[0-9a-fA-F]{64,}/g,'[REDACTED]').replace(/https?:\/\/[^\s"']+/g,'[URL REDACTED]');
}
export function loadEnvFile() {
  const i=process.argv.indexOf('--env');
  const file=i>=0 ? process.argv[i+1] : '.env';
  if(i>=0 && !file) throw new Error('--env requires a path');
  try {
    const info=lstatSync(file);if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077))throw Error('Env must be a private regular file (0600)');
    process.loadEnvFile(file);
  } catch(e) { if(e.code!=='ENOENT' || i>=0) throw e; }
}
