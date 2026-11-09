# Settlement poll self-heal

The seller's CloseRequested poll cursor lives in memory (node.js: `_closeRequestedFromBlock`).
It is initialized to the current block at startup and advances only when a poll succeeds.
One transient RPC failure freezes it; the next poll then spans the frozen cursor to head,
a range that eventually exceeds every free-tier getLogs cap. The seller keeps serving,
but channel settlements silently stop.

## What the watchdog does

`scripts/settlement-watchdog.py` runs every 5 minutes (systemd timer) and:

1. Counts `Failed to poll CloseRequested` lines in the **current instance's** journal
   (PID-filtered, so dead instances can never trigger a restart loop) over the last 8 minutes.
2. Fewer than 2 failures: exit 0, no action. A single transient failure must not restart anything.
3. Seller restarted within the last 3 minutes: skip, give it time.
4. Otherwise: restart the seller. The cursor resets to head and settlement polling resumes.

Fail-closed: if the PID, journal or restart call fails, it logs and exits non-zero without acting.

## The poll's RPC requirements

- The poll runs every 60s; Base mines ~30 blocks/minute, so a healthy poll spans ~30 blocks.
- Endpoints with a getLogs range cap BELOW ~35 blocks fail on every poll
  (measured: Alchemy free tier caps at 10 blocks - unusable for this poll).
- Endpoints with a ~10,000-block cap (e.g. dRPC free) work fine while the cursor is fresh;
  the watchdog's restart turns any frozen-cursor incident into a bounded gap.
- Events emitted while the cursor is frozen are skipped by the restart (the cursor jumps to head);
  they settle later through the timeout path, not the event path.

## Install

```sh
sudo cp scripts/settlement-watchdog.py /opt/antseed-surplus/scripts-ops/
sudo cp scripts/systemd/antseed-settlement-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now antseed-settlement-watchdog.timer
```
