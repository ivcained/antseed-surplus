#!/usr/bin/env node
import { setTimeout as pause } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as topupMain } from './topup.mjs';
import { redactError } from '../lib/settings.mjs';

const HELP = `Serialized Surplus balance / revenue-funded topup monitor
Usage: node scripts/monitor.mjs [--env FILE] [--once] [--execute] [--interval-seconds N]

Dry-run by default; TOPUP_EXECUTE does not authorize spending.
Only --execute forwards transfer authorization to the treasury CLI.
The interval is measured after each completed iteration: default 60 seconds,
minimum 30, maximum 86400. No overlapping treasury calls.
--once performs one iteration and exits; pending transaction states exit 2.
Unknown sends are reconciled only by the treasury's exact transaction journal.
Safety/configuration/network errors stop the monitor, never blind-retry sends.
SIGINT/SIGTERM stop scheduling; an in-flight treasury operation finishes safely.
`;
function options(argv) {
  const result = { topupArgs: [], intervalMs: 60000, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--env requires a file');
      result.topupArgs.push('--env', argv[++i]);
    } else if (argv[i] === '--execute') result.topupArgs.push('--execute');
    else if (argv[i] === '--once') result.once = true;
    else if (argv[i] === '--interval-seconds') {
      const raw = argv[++i];
      if (!/^[1-9][0-9]*$/.test(raw ?? '') || !Number.isSafeInteger(Number(raw)) || Number(raw) < 30 || Number(raw) > 86400) throw new Error('Invalid interval: requires integer seconds from 30 through 86400');
      result.intervalMs = Number(raw) * 1000;
    } else if (argv[i] === '--help' || argv[i] === '-h') result.help = true;
    else throw new Error('Unknown argument; use --help');
  }
  return result;
}
const safeStatuses = new Set(['no-topup', 'dry-run', 'credit-observed', 'broadcast-uncertain', 'mined-awaiting-credit']);
export async function runMonitor(argv = process.argv.slice(2), env = process.env, adapters = {}) {
  const config = options(argv);
  if (config.help) { console.log(HELP); return; }
  const invoke = adapters.topupMain ?? topupMain;
  const sleep = adapters.sleep ?? ((ms, signal) => pause(ms, undefined, { signal }));
  const signal = adapters.signal;
  let iterations = 0, status = 'stopped';
  while (!signal?.aborted) {
    const result = await invoke(config.topupArgs, env);
    iterations++;
    if (!safeStatuses.has(result?.status)) throw new Error('Unknown treasury status; stopped for inspection');
    status = result.status;
    // Never reset process.exitCode: unresolved sends must stay visible to the
    // service supervisor even if later balance iterations look healthy.
    if (config.once || signal?.aborted) break;
    try { await sleep(config.intervalMs, signal); }
    catch (error) { if (signal?.aborted && error?.name === 'AbortError') break; throw error; }
  }
  return { iterations, status };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  runMonitor(process.argv.slice(2), process.env, { signal: controller.signal }).catch((error) => {
    // Provider errors can embed entire replayable transactions. Never log them.
    console.error(`Monitor stopped: ${error?.code ? 'Operation failed; inspect private journal and RPC availability' : redactError(error)}`);
    process.exitCode = 1;
  }).finally(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
}
