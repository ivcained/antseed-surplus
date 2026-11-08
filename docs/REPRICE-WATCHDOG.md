# Reprice watchdog

The per-model de-list guard stops selling a model when its upstream estimate
rises beyond the advertised price. Missing-upstream de-lists self-heal on a
later refresh, but PRICE-RISE de-lists persist until a re-price (the daily
consent renewal), leaving the model dark for up to a day. This watchdog
closes that gap: when the live quotes carry a price-rise de-list and the
last re-price is older than the minimum gap (30 minutes), it runs the
consented renewal — regenerate pricing policy and quotes, restart — so the
affected models return at fresh, fully-cushioned prices.

Install the script and the two unit files the same way as the RPC watchdog
(see docs/RPC-FAILOVER.md), with:

```sh
sudo -S -p '' install -m 700 scripts/reprice-watchdog.py /opt/antseed-surplus/scripts-ops/reprice-watchdog.py
sudo -S -p '' install -m 644 scripts/systemd/antseed-reprice-watchdog.service scripts/systemd/antseed-reprice-watchdog.timer /etc/systemd/system/
sudo -S -p '' systemctl daemon-reload
sudo -S -p '' systemctl enable --now antseed-reprice-watchdog.timer
```

Defaults assume the documented deployment. Override with `--state-dir`,
`--log`, `--renew` (path to the consented renewal script), or
`--min-gap-seconds`. Decisions are appended to the log; secrets never are.
