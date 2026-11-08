#!/usr/bin/env python3
"""Reprice watchdog for the AntSeed seller.

The per-model de-list guard stops selling a model when its upstream estimate
rises beyond the advertised price. Missing-upstream de-lists self-heal on a
later refresh, but PRICE-RISE de-lists persist until a re-price (the daily
consent renewal), leaving the model dark for up to a day. This watchdog
closes that gap: when the live quotes carry a price-rise de-list and the
last re-price is older than the minimum gap, it runs the consented renewal
(regenerate policy + quotes, restart) so affected models return at fresh,
fully-cushioned prices.

Run behind a systemd timer every 5 minutes. Secrets never appear in logs.
"""
import argparse, json, os, subprocess, sys, time

LOG_PATH = ""
STATE_DIR = "/opt/antseed-surplus/.state"
RENEW = "/opt/antseed-surplus/scripts-ops/renew-pricing.sh"
MIN_GAP_SECONDS = 30 * 60

def log(msg: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"{stamp} {msg}"
    print(line, flush=True)
    if LOG_PATH:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")

def price_rise_delists(quotes_path: str) -> list:
    try:
        q = json.load(open(quotes_path))
    except Exception as e:
        log(f"quotes unreadable ({type(e).__name__}); skipping")
        return []
    un = q.get("unavailable") or {}
    return [m for m, reason in un.items()
            if isinstance(reason, str) and reason.startswith("de-listed:")
            and "rose beyond advertised" in reason]

def main() -> None:
    global LOG_PATH, STATE_DIR, RENEW, MIN_GAP_SECONDS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--state-dir", default=STATE_DIR)
    ap.add_argument("--log", default="/opt/antseed-surplus/scripts-ops/reprice-watchdog.log")
    ap.add_argument("--renew", default=RENEW, help="consented renewal script (write-policy + prices + restart)")
    ap.add_argument("--min-gap-seconds", type=int, default=MIN_GAP_SECONDS)
    args = ap.parse_args()
    LOG_PATH = args.log
    STATE_DIR = args.state_dir
    RENEW = args.renew
    MIN_GAP_SECONDS = args.min_gap_seconds
    os.makedirs(os.path.dirname(args.log), exist_ok=True)

    affected = price_rise_delists(os.path.join(STATE_DIR, "quotes.json"))
    if not affected:
        sys.exit(0)
    stamp = os.path.join(STATE_DIR, "last-reprice")
    if os.path.exists(stamp):
        try:
            age = time.time() - os.path.getmtime(stamp)
        except FileNotFoundError:
            age = 1e9
        if age < MIN_GAP_SECONDS:
            log(f"{len(affected)} price-rise de-list(s) ({', '.join(affected[:3])}) but last re-price {int(age)//60}m ago < {MIN_GAP_SECONDS//60}m gap; waiting")
            sys.exit(0)
    log(f"price-rise de-list(s) present ({', '.join(affected[:5])}); running consented renewal")
    r = subprocess.run(["bash", RENEW], capture_output=True, text=True, timeout=600)
    tail = "\n".join((((r.stdout or "") + (r.stderr or "")) or "").splitlines()[-3:])
    if r.returncode == 0:
        open(stamp, "w").close()
        log(f"renewal OK; affected models re-priced: {tail}")
    else:
        log(f"WARN renewal exited {r.returncode}: {tail}")
        sys.exit(1)

if __name__ == "__main__":
    main()
