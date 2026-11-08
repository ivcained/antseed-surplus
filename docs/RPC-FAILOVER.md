# RPC failover watchdog

A live AntSeed seller is a buyer of Base settlement: channel settlement, gas
checks and on-chain reads all go through `ANTSEED_BASE_RPC_URL`. On
2026-11-08 the endpoint configured on one deployment
(`base.gateway.tenderly.co`) stopped resolving by DNS. The seller fail-closed
correctly — `Payments disabled: RPC node unreachable` — and served nothing
until an operator swapped the endpoint by hand. This watchdog automates that
swap.

## What it does

Every run (deploy behind a systemd timer, every 5 minutes):

1. Reads `ANTSEED_BASE_RPC_URL` from the seller env file.
2. Health-checks it twice: `eth_chainId` must be `0x2104` (Base 8453) and
   `eth_getLogs` over the AntSeed channels contract must answer. getLogs is
   checked explicitly: one public endpoint accepted chain reads while
   rejecting the event range with HTTP 400, which keeps the seller down.
3. If both checks fail, Base RPC candidates are pulled from the DefiLlama
   chainlist API (`https://chainlist.org/rpcs.json`, cached for 6 hours),
   ranked by measured `eth_chainId` latency, and the first candidate that
   passes the full health check is written back into the env file.
4. The seller and monitor units are restarted with stale-lock cleanup that
   only removes a `seller.lock` after confirming its pid is gone.
5. Every decision is appended to the log file. If no healthy endpoint is
   found, the env file is left untouched and the script exits 1 so the next
   timer run retries — fail closed, never to an unverified endpoint.

## Install

```sh
# 1. Copy the script and unit files to the host running the seller.
sudo install -m 700 scripts/rpc-watchdog.py /opt/antseed-surplus/scripts-ops/rpc-watchdog.py

# 2. Adjust the paths/prefix inside the unit file to your deployment, then:
sudo install -m 644 scripts/systemd/antseed-rpc-watchdog.service scripts/systemd/antseed-rpc-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antseed-rpc-watchdog.timer
```

Unit and timer contents are in [`scripts/systemd/`](../scripts/systemd/).
Defaults assume the documented deployment: env at `/opt/antseed-surplus/.env`,
units `antseed-surplus-seller` / `antseed-surplus-monitor`. Override with
`--env`, `--state-dir`, `--log`, `--unit-prefix`, or `--no-restart`.

## Known endpoint pitfalls

- Several chainlist endpoints and RPC hosts are behind Cloudflare and return
  403 to the default python-urllib user agent. All HTTP calls here send a
  browser-like UA; keep that when editing.
- Free-tier endpoints differ in what they allow: one rejected getLogs ranges
  over 10000 blocks with HTTP 400, another rate-limited the official host.
  The health check exercises the exact query type the seller needs, so those
  are rejected before they can break settlement.
- Public endpoints rate-limit per IP. If your seller runs long-term, prefer a
  paid RPC for the primary and keep the watchdog as the safety net.

## Scope

Failover changes only `ANTSEED_BASE_RPC_URL`. Secrets are never logged; the
log records URLs, decisions and restart state only.
