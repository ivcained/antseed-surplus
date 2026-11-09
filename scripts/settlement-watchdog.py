#!/usr/bin/env python3
"""Self-heal the seller settlement poll: the CloseRequested poll cursor is
in-memory; one transient RPC failure freezes it and the poll range grows past
every free-tier getLogs cap until restart. Detect repeated poll failures in
the recent journal and restart the seller (cursor resets to head at start).
Fail-closed: only acts on clear evidence; skips if the seller just restarted."""
import subprocess, sys, time
from datetime import datetime, timezone

WINDOW_MIN = 8          # look-back window; poll runs every 60s
MIN_FAILURES = 2        # >=2 failed cycles = frozen, not a one-off
RESTART_GUARD_SEC = 180 # never restart if the seller restarted this recently
LOG = "/opt/antseed-surplus/scripts-ops/settlement-watchdog.log"

def log(msg):
    line = "{} {}".format(datetime.now(timezone.utc).isoformat(timespec="seconds"), msg)
    print(line)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)

# 1. recent failures IN THE CURRENT INSTANCE ONLY? (journalctl without a PID
#    filter also returns dead instances' lines, so every restart would poison
#    the window and cause a restart loop)
pid_s = run(["systemctl", "show", "-p", "MainPID", "--value",
             "antseed-surplus-seller"]).stdout.strip()
if not pid_s.isdigit() or pid_s == "0":
    log("FAIL: could not read seller main PID (got {!r})".format(pid_s))
    sys.exit(1)
q = run(["journalctl", "-u", "antseed-surplus-seller", "_PID=" + pid_s,
         "--since", "-{} min".format(WINDOW_MIN), "--no-pager"])
if q.returncode != 0:
    log("FAIL: journalctl rc={}: {}".format(q.returncode, q.stderr[:200]))
    sys.exit(1)
n = q.stdout.count("Failed to poll CloseRequested")
if n < MIN_FAILURES:
    sys.exit(0)  # healthy (or a single transient failure) - do nothing

# 2. restarted too recently? (main PID age)
up = run(["ps", "-o", "etimes=", "-p", pid_s])
try:
    up_s = int(up.stdout.strip())
except ValueError:
    log("FAIL: could not read PID age for {}: {!r}".format(pid_s, up.stdout[:80]))
    sys.exit(1)
if up_s < RESTART_GUARD_SEC:
    log("SKIP: {} failures but seller up only {}s; giving it time".format(n, up_s))
    sys.exit(0)

# 3. restart to reset the cursor
r = run(["systemctl", "restart", "antseed-surplus-seller"])
if r.returncode != 0:
    log("FAIL: restart rc={}: {}".format(r.returncode, r.stderr[:200]))
    sys.exit(1)
time.sleep(30)
chk = run(["systemctl", "is-active", "antseed-surplus-seller"])
state = chk.stdout.strip()
ok = state == "active"
log("{}: {} poll failures in {}min -> restart issued; seller now {}".format(
    "OK" if ok else "FAIL", n, WINDOW_MIN, state))
sys.exit(0 if ok else 1)
