import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const module = await import('../scripts/monitor.mjs').catch(() => ({}));

test('monitor once is read-only by default and forwards private env file without logging it', async () => {
  assert.equal(typeof module.runMonitor, 'function', 'missing serialized monitor');
  const calls = [];
  const env = { SURPLUS_API_KEY: 'inf_offline_secret', TOPUP_EXECUTE: 'true' };
  const result = await module.runMonitor(['--once', '--env', '/private/config.env'], env, {
    topupMain: async (argv, actualEnv) => { calls.push(argv); assert.equal(actualEnv, env); return { status: 'dry-run' }; },
    sleep: async () => { assert.fail('once must not sleep'); },
  });
  assert.deepEqual(calls, [['--env', '/private/config.env']]);
  assert.deepEqual(result, { iterations: 1, status: 'dry-run' });
});

test('monitor explicitly forwards execute and waits between completed iterations without overlap', async () => {
  const controller = new AbortController();
  let active = 0, maxActive = 0, iterations = 0;
  const waits = [];
  const result = await module.runMonitor(['--execute', '--interval-seconds', '30'], {}, {
    signal: controller.signal,
    topupMain: async (argv) => {
      assert.deepEqual(argv, ['--execute']);
      active++; maxActive = Math.max(active, maxActive);
      await Promise.resolve(); active--; iterations++;
      if (iterations === 3) controller.abort();
      return { status: iterations === 1 ? 'broadcast-uncertain' : iterations === 2 ? 'mined-awaiting-credit' : 'credit-observed' };
    },
    sleep: async (ms, signal) => { assert.equal(active, 0); assert.equal(signal, controller.signal); waits.push(ms); },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(waits, [30000, 30000]);
  assert.deepEqual(result, { iterations: 3, status: 'credit-observed' });
});

test('monitor stops on safety exceptions and unknown statuses instead of retrying', async () => {
  let calls = 0;
  const failure = new Error('Journal changed; refusing transaction');
  await assert.rejects(module.runMonitor([], {}, {
    topupMain: async () => { calls++; throw failure; },
    sleep: async () => assert.fail('must stop'),
  }), (error) => error === failure);
  assert.equal(calls, 1);
  await assert.rejects(module.runMonitor([], {}, { topupMain: async () => ({ status: 'surprise' }) }), /status/);
});

test('monitor cancellation stops waiting and a pre-aborted signal does not invoke treasury', async () => {
  const controller = new AbortController();
  const result = await module.runMonitor([], {}, {
    signal: controller.signal,
    topupMain: async () => { setImmediate(() => controller.abort()); return { status: 'no-topup' }; },
  });
  assert.deepEqual(result, { iterations: 1, status: 'no-topup' });
  const preAborted = AbortSignal.abort();
  assert.deepEqual(await module.runMonitor([], {}, { signal: preAborted, topupMain: () => assert.fail('aborted') }), { iterations: 0, status: 'stopped' });
});

test('monitor keeps nonzero treasury exit code visible rather than masking a pending send', async () => {
  const previous = process.exitCode;
  try {
    await module.runMonitor(['--once'], {}, { topupMain: async () => { process.exitCode = 2; return { status: 'broadcast-uncertain' }; } });
    assert.equal(process.exitCode, 2);
  } finally { process.exitCode = previous; }
});

test('monitor validates bounded intervals and strict flags before any treasury call', async () => {
  const adapters = { topupMain: () => assert.fail('invalid config must not run') };
  for (const argv of [['--interval-seconds', '29'], ['--interval-seconds', '86401'], ['--interval-seconds', '1e3'], ['--interval-seconds'], ['--env'], ['--env', '--execute'], ['--unknown']]) {
    await assert.rejects(module.runMonitor(argv, {}, adapters), /interval|requires|Unknown/);
  }
});

test('setup and monitor help execute without credentials or network access', () => {
  for (const script of ['scripts/setup.mjs', 'scripts/monitor.mjs']) {
    const result = spawnSync(process.execPath, [script, '--help'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  }
});

test('monitor CLI errors redact secrets and never dump provider payloads', () => {
  const result = spawnSync(process.execPath, ['scripts/monitor.mjs', '--env', '/nonexistent/inf_do_not_print'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Monitor stopped:/);
  assert.equal(result.stderr.includes('inf_do_not_print'), false);
  assert.equal(result.stdout, '');
});
