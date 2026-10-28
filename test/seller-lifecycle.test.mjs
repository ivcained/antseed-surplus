import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Every case runs in an isolated runner with a real disposable Node child and
// loopback HTTP server. No AntSeed CLI, API, wallet file, or live state is used.
const harness = String.raw`
import { spawn as realSpawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const { scenario, stateDir } = JSON.parse(process.argv[1]);
const lockPath = join(stateDir, 'seller.lock');
const configPath = join(stateDir, 'config.json');
const manifestPath = join(stateDir, 'home', '.antseed', 'plugins', 'package.json');
const snapshot = { settled: false, closeCalls: 0, gatewayClosed: false, spawns: 0, fetches: 0 };
let child, gateway, blocker, onEvent;
let ready;
const childReady = new Promise(resolve => { ready = resolve; });
const quote = { services: { test: { provider: 'venice', upstreamModel: 'test',
  pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 1 },
  upstreamPricing: { inputUsdPerMillion: .5, outputUsdPerMillion: 1, cachedInputUsdPerMillion: .5 },
  maxPricePer1m: 1 } } };
if (scenario === 'occupied') {
  await mkdir(join(stateDir, 'home', '.antseed', 'plugins'), { recursive: true });
  await writeFile(lockPath, 'other-owner');
  await writeFile(configPath, 'sentinel-config');
  await writeFile(manifestPath, 'sentinel-manifest');
}
if (scenario === 'logFailure') await mkdir(join(stateDir, 'seller.log'));
if (scenario === 'eventFailure') await mkdir(join(stateDir, 'gateway-events.jsonl'));
const settings = { stateDir, gatewayPort: 0, dhtPort: 0, signalingPort: 0,
  rpcUrl: 'http://127.0.0.1:1', maxConcurrent: 1, refreshMs: 80, lossTest: false };
if (scenario === 'listenFailure') {
  blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  settings.gatewayPort = blocker.address().port;
}
const spawnImpl = (_executable, _args, options) => {
  snapshot.spawns++;
  let source = "process.on('SIGINT', () => process.exit(0)); console.log('CHILD_READY'); setInterval(() => {}, 1000);";
  if (scenario === 'signalExit') source = "process.kill(process.pid, 'SIGKILL');";
  if (scenario === 'paymentDisabled') source = "process.on('SIGINT', () => process.exit(0)); console.log('CHILD_READY'); console.log('Payments disabled'); setInterval(() => {}, 1000);";
  if (scenario === 'escalation') source = "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('CHILD_READY'); setInterval(() => {}, 1000);";
  child = scenario === 'spawnFailure'
    ? realSpawn(join(stateDir, 'nonexistent-executable'), [], options)
    : realSpawn(process.execPath, ['--input-type=module', '-e', source], options);
  child.stdout.on('data', chunk => {
    if (!String(chunk).includes('CHILD_READY')) return;
    ready();
    if (scenario === 'eventFailure') onEvent({ type: 'fixture' });
    if (scenario === 'operator' || scenario === 'escalation') {
      process.emit('SIGINT');
      process.emit('SIGTERM');
    }
  });
  return child;
};
const { runSeller } = await import('./lib/seller.mjs');
function report(timedOut = false) {
  snapshot.timedOut = timedOut;
  snapshot.lockExists = existsSync(lockPath);
  snapshot.childExitCode = child?.exitCode;
  snapshot.childSignalCode = child?.signalCode;
  if (scenario === 'occupied') {
    snapshot.lockContents = readFileSync(lockPath, 'utf8');
    snapshot.configContents = readFileSync(configPath, 'utf8');
    snapshot.manifestContents = readFileSync(manifestPath, 'utf8');
  }
  console.log('SELLER_RESULT ' + JSON.stringify(snapshot));
}
const watchdog = setTimeout(() => {
  report(true);
  child?.kill('SIGKILL');
  gateway?.closeAllConnections();
  gateway?.close();
  blocker?.close();
  setTimeout(() => process.exit(0), 100);
}, 2500);
try {
  snapshot.code = await runSeller({ settings, apiKey: 'fixture-not-a-credential',
    wallet: { address: 'fixture-address', privateKey: '0x' + '1'.repeat(64) },
    spawnImpl, shutdownGraceMs: 50, terminateGraceMs: 50,
    fetchQuotes: async () => {
      snapshot.fetches++;
      snapshot.lockDuringFetch = existsSync(lockPath);
      if (scenario === 'initialFailure') throw new Error('fixture initial quote failure');
      if (scenario === 'refreshFailure' && snapshot.fetches > 1) {
        await childReady;
        throw new Error('fixture quote refresh failure');
      }
      return quote;
    },
    createGateway: options => {
      if (scenario === 'constructorFailure') throw new Error('fixture gateway constructor failure');
      onEvent = options.onEvent;
      gateway = createServer((_req, res) => res.end('fixture'));
      const close = gateway.close.bind(gateway);
      gateway.close = callback => {
        snapshot.closeCalls++;
        return close(error => setTimeout(() => {
          snapshot.lockUntilClosed = existsSync(lockPath);
          snapshot.gatewayClosed = true;
          callback?.(error);
        }, 30));
      };
      return gateway;
    }
  });
} catch (error) {
  snapshot.error = error.message;
}
snapshot.settled = true;
clearTimeout(watchdog);
blocker?.close();
report();
`;

async function runCase(t, scenario) {
  assert.ok(process.env.TMPDIR, 'Hermes scratch TMPDIR is required');
  const stateDir = await mkdtemp(join(process.env.TMPDIR, 'seller-lifecycle-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', harness, JSON.stringify({ scenario, stateDir })], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 7000,
      env: { PATH: process.env.PATH, HOME: stateDir, TMPDIR: process.env.TMPDIR }
    });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find(line => line.startsWith('SELLER_RESULT '));
  assert.ok(line, `missing runner result: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('SELLER_RESULT '.length));
}
function assertClean(result) {
  assert.equal(result.timedOut, false, JSON.stringify(result));
  assert.equal(result.settled, true);
  assert.equal(result.gatewayClosed, true);
  assert.equal(result.closeCalls, 1);
  assert.equal(result.lockUntilClosed, true, 'ownership must last through gateway shutdown');
  assert.equal(result.lockExists, false);
}
function assertFatal(result) {
  assert.ok(result.error || (Number.isInteger(result.code) && result.code !== 0), JSON.stringify(result));
  assertClean(result);
}

test('signal-terminated child settles, closes the gateway and releases ownership', async t => {
  const result = await runCase(t, 'signalExit');
  assertFatal(result);
  assert.equal(result.childSignalCode, 'SIGKILL');
});
test('quote-refresh safety shutdown cannot become success when child exits zero', async t => {
  const result = await runCase(t, 'refreshFailure');
  assertFatal(result);
  assert.equal(result.childExitCode, 0);
  assert.equal(result.fetches, 2);
});
test('occupied seller lock prevents quote reads and runtime/config/manifest writes', async t => {
  const result = await runCase(t, 'occupied');
  assert.match(result.error, /Seller lock exists/);
  assert.equal(result.configContents, 'sentinel-config');
  assert.equal(result.manifestContents, 'sentinel-manifest');
  assert.equal(result.lockContents, 'other-owner');
  assert.equal(result.fetches, 0);
  assert.equal(result.spawns, 0);
});
test('payment-disabled child stdout causes a nonzero safety result', async t => {
  const result = await runCase(t, 'paymentDisabled');
  assertFatal(result);
  assert.equal(result.childExitCode, 0);
});
for (const scenario of ['eventFailure', 'logFailure']) {
  test(`${scenario} shuts down fail-closed despite a zero child exit`, async t => {
    const result = await runCase(t, scenario);
    assertFatal(result);
    assert.equal(result.childExitCode, 0);
  });
}
test('operator signals share complete shutdown and preserve clean exit zero', async t => {
  const result = await runCase(t, 'operator');
  assertClean(result);
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
});
test('spawn ENOENT settles without waiting for a nonexistent exit event', async t => {
  const result = await runCase(t, 'spawnFailure');
  assertFatal(result);
  assert.equal(result.spawns, 1);
});
test('gateway constructor failure releases only its acquired lock', async t => {
  const result = await runCase(t, 'constructorFailure');
  assert.equal(result.timedOut, false);
  assert.match(result.error, /fixture gateway constructor failure/);
  assert.equal(result.lockExists, false);
  assert.equal(result.spawns, 0);
});
test('gateway listen failure cleans up before releasing its lock', async t => {
  const result = await runCase(t, 'listenFailure');
  assertFatal(result);
  assert.equal(result.spawns, 0);
});
test('initial quote failure occurs under ownership and releases its lock', async t => {
  const result = await runCase(t, 'initialFailure');
  assert.equal(result.timedOut, false);
  assert.match(result.error, /fixture initial quote failure/);
  assert.equal(result.lockDuringFetch, true);
  assert.equal(result.lockExists, false);
});
test('uncooperative disposable child is escalated through TERM to KILL', async t => {
  const result = await runCase(t, 'escalation');
  assertFatal(result);
  assert.equal(result.childSignalCode, 'SIGKILL');
});
