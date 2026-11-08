#!/usr/bin/env python3
"""Surplus key auto-rotation watchdog for the AntSeed seller.

The seller buys inference with a prepaid Surplus `inf_` key. When that
key/workspace runs out of credit the seller starts answering 402s. This
watchdog (systemd timer, every 5 minutes) checks the credit of the CURRENT
staged key and, when it falls to/below the threshold, promotes a staged
replacement key so rotation happens without operator action:

    .state/surplus-key-next.env  ->  .state/surplus-key.env
    (previous key archived as .state/surplus-key.previous-<stamp>.env)
    seller and monitor units restarted

Stage a replacement key out-of-band (never through chat or shell history):
run the `stage-surplus-key` helper on the seller host and paste blind.

Notes:
- Credit is scoped per key/workspace on Surplus: verify the staged key's own
  balance after staging; a key from an unfunded workspace adds nothing.
- Secrets never appear in logs; only prefixes, suffixes and decisions do.
"""
import argparse, json, os, shutil, subprocess, sys, time, urllib.request

LOG_PATH = ""
CUR_NAME = "surplus-key.env"
NEXT_NAME = "surplus-key-next.env"

def log(msg: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"{stamp} {msg}"
    print(line, flush=True)
    if LOG_PATH:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")

def current_key(cur: str) -> str:
    text = open(cur).read().strip()
    line = next((l for l in text.splitlines() if l.startswith("SURPLUS_API_KEY=")), None)
    if not line:
        raise SystemExit("current key file malformed")
    return line.split("=", 1)[1].strip()

def credit_micro(key: str) -> int:
    req = urllib.request.Request(
        "https://api.surplusintelligence.ai/v1/payments/balance",
        headers={"Authorization": f"Bearer {key}", "accept": "application/json",
                 "User-Agent": "antseed-key-watchdog/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read().decode())
    return int(d["credit_balance_usdc"])

def promote(state_dir: str, cur: str, nxt: str) -> None:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    shutil.copy2(cur, os.path.join(state_dir, f"surplus-key.previous-{stamp}.env"))
    os.replace(nxt, cur)
    os.chmod(cur, 0o600)
    log("staged key promoted to current")

def restart_units(prefix: str, state_dir: str) -> bool:
    subprocess.run(["systemctl", "stop", f"{prefix}-seller"], check=False)
    lock = os.path.join(state_dir, "seller.lock")
    for _ in range(10):
        if not os.path.exists(lock):
            break
        try:
            pid = int(json.load(open(lock)).get("pid"))
            os.kill(pid, 0)
            time.sleep(1)
        except (ProcessLookupError, FileNotFoundError, ValueError, KeyError):
            try:
                os.remove(lock)
            except FileNotFoundError:
                pass
            break
    for unit in (f"{prefix}-seller", f"{prefix}-monitor"):
        subprocess.run(["systemctl", "reset-failed", unit], check=False)
    subprocess.run(["systemctl", "start", "--no-block", f"{prefix}-seller"], check=False)
    subprocess.run(["systemctl", "restart", f"{prefix}-monitor"], check=False)
    time.sleep(45)
    state = subprocess.run(["systemctl", "is-active", f"{prefix}-seller"],
                           capture_output=True, text=True).stdout.strip()
    return state == "active"

def main() -> None:
    global LOG_PATH
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--state-dir", default="/opt/antseed-surplus/.state")
    ap.add_argument("--log", default="/opt/antseed-surplus/scripts-ops/key-watchdog.log")
    ap.add_argument("--unit-prefix", default="antseed-surplus")
    ap.add_argument("--threshold-micros", type=int, default=50_000,
                    help="promote the staged key when credit <= this (default $0.05)")
    args = ap.parse_args()
    LOG_PATH = args.log
    os.makedirs(os.path.dirname(args.log), exist_ok=True)

    state_dir, cur = args.state_dir, os.path.join(args.state_dir, CUR_NAME)
    nxt = os.path.join(args.state_dir, NEXT_NAME)
    low_mark = os.path.join(args.state_dir, "key-low.flag")

    key = current_key(cur)
    try:
        micro = credit_micro(key)
    except Exception as e:
        log(f"balance check failed ({type(e).__name__}: {str(e)[:100]}); leaving keys alone")
        sys.exit(1)

    if micro > args.threshold_micros:
        if os.path.exists(low_mark):
            os.remove(low_mark)
        sys.exit(0)

    if os.path.exists(nxt):
        log(f"credit low ({micro} micros <= {args.threshold_micros}) with staged key present: rotating")
        promote(state_dir, cur, nxt)
        if restart_units(args.state_dir, args.unit_prefix):
            log("seller restarted active on the new key")
            if os.path.exists(low_mark):
                os.remove(low_mark)
            sys.exit(0)
        log("WARN: seller not active after key promotion; check journal")
        sys.exit(1)

    if not os.path.exists(low_mark):
        open(low_mark, "w").close()
        os.chmod(low_mark, 0o600)
        log(f"WARN: credit low ({micro} micros <= {args.threshold_micros}) and no staged key at {nxt}")

if __name__ == "__main__":
    main()
