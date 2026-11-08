#!/usr/bin/env python3
"""RPC failover watchdog for the AntSeed seller on Base (chain 8453).

Health-checks the ANTSEED_BASE_RPC_URL configured in the seller env file.
Two consecutive failures (chain-id mismatch, dead host, or an eth_getLogs
rejection on the channels contract — the query type that silently broke a
live deployment) trigger failover: candidate endpoints are pulled from the
DefiLlama chainlist API, ranked by measured latency, and the first candidate
that passes the full check is written back into the env file. The seller and
monitor units are then restarted with stale-lock cleanup that only removes a
lock after confirming its pid is dead.

Every decision is logged. If no healthy endpoint is found, the env file is
left untouched and the script exits 1 so the next timer run retries.

Designed for a systemd timer running every few minutes. All HTTP calls carry
a browser-like User-Agent: several chainlist endpoints (and Cloudflare-fronted
RPCs) return 403 to the default python-urllib agent.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request

CHAINLIST_API = "https://chainlist.org/rpcs.json"
CHAIN_ID = 8453
CHAIN_ID_HEX = hex(CHAIN_ID)
CHANNELS_CONTRACT = "0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d"
TIMEOUT = 6
CACHE_MAX_AGE = 6 * 3600
UA = "Mozilla/5.0 (X11; Linux x86_64) antseed-rpc-watchdog/1.0"

LOG_PATH = ""


def log(msg: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"{stamp} {msg}"
    print(line, flush=True)
    if LOG_PATH:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")


def rpc_call(url: str, method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body,
        headers={"content-type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        out = json.loads(r.read().decode())
    if "error" in out:
        raise RuntimeError(f"{method} error: {out['error'].get('message', '?')[:120]}")
    return out["result"]


def healthy(url: str):
    try:
        if rpc_call(url, "eth_chainId", []) != CHAIN_ID_HEX:
            return False, "wrong chain id"
        latest = int(rpc_call(url, "eth_blockNumber", []), 16)
        rpc_call(url, "eth_getLogs", [{"fromBlock": hex(max(1, latest - 80)), "toBlock": "latest", "address": CHANNELS_CONTRACT}])
        return True, "ok"
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e)[:140]}"


def current_rpc(env_path: str) -> str:
    text = open(env_path).read()
    for line in text.splitlines():
        m = re.match(r"ANTSEED_BASE_RPC_URL=(.+)", line.strip())
        if m:
            return m.group(1).strip()
    raise SystemExit(f"ANTSEED_BASE_RPC_URL not found in {env_path}")


def set_rpc(env_path: str, url: str) -> None:
    lines = open(env_path).read().splitlines()
    out = [("ANTSEED_BASE_RPC_URL=" + url if l.startswith("ANTSEED_BASE_RPC_URL=") else l) for l in lines]
    with open(env_path, "w") as f:
        f.write("\n".join(out) + "\n")
    os.chmod(env_path, 0o600)


def candidates(cache_path: str) -> list:
    def entry_from_cache():
        with open(cache_path) as f:
            return json.load(f)

    def fetch_entry():
        req = urllib.request.Request(CHAINLIST_API,
            headers={"User-Agent": UA, "accept": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT * 2) as r:
            all_chains = json.loads(r.read().decode())
        entry = next((c for c in all_chains if c.get("chainId") == CHAIN_ID), None)
        if not entry:
            raise RuntimeError("chain 8453 missing from chainlist")
        with open(cache_path, "w") as f:
            json.dump(entry, f)
        return entry

    try:
        entry = entry_from_cache()
        if time.time() - os.path.getmtime(cache_path) > CACHE_MAX_AGE:
            entry = fetch_entry()
    except FileNotFoundError:
        entry = fetch_entry()
    except Exception as e:
        if os.path.exists(cache_path):
            log(f"chainlist fetch failed ({e}); using cached list")
            entry = entry_from_cache()
        else:
            raise
    urls = []
    for u in entry.get("rpc", []):
        if isinstance(u, dict):
            u = u.get("url")
        if isinstance(u, str) and u.startswith("https://") and "${" not in u:
            urls.append(u)
    measured = []
    for u in urls:
        t0 = time.monotonic()
        try:
            if rpc_call(u, "eth_chainId", []) != CHAIN_ID_HEX:
                continue
            measured.append((time.monotonic() - t0, u))
        except Exception:
            continue
    measured.sort()
    return [u for _, u in measured]


def restart_services(state_dir: str, prefix: str) -> bool:
    """Stop seller, clear only a provably stale lock, restart seller + monitor."""
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
    else:
        log(f"WARN: {lock} still held after stop; not removing")
        return False
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
    ap.add_argument("--env", default="/opt/antseed-surplus/.env")
    ap.add_argument("--state-dir", default="/opt/antseed-surplus/.state")
    ap.add_argument("--log", default="/opt/antseed-surplus/scripts-ops/rpc-watchdog.log")
    ap.add_argument("--cache", default=None, help="chainlist cache path (default: alongside log)")
    ap.add_argument("--unit-prefix", default="antseed-surplus")
    ap.add_argument("--no-restart", action="store_true", help="write .env but skip systemctl restarts")
    args = ap.parse_args()
    cache = args.cache or os.path.join(os.path.dirname(args.log), "chainlist-8453.json")
    LOG_PATH = args.log
    os.makedirs(os.path.dirname(args.log), exist_ok=True)

    cur = current_rpc(args.env)
    results = [healthy(cur) for _ in range(2)]
    if any(ok for ok, _ in results):
        sys.exit(0)
    log(f"current RPC unhealthy: {cur} ({results[-1][1]}) — searching chainlist for a replacement")
    for url in candidates(cache):
        if url == cur:
            continue
        ok, why = healthy(url)
        if not ok:
            log(f"candidate rejected: {url} ({why})")
            continue
        set_rpc(args.env, url)
        log(f"switched RPC -> {url}")
        if args.no_restart:
            log("written; --no-restart set, skipping service restart")
            sys.exit(0)
        if restart_services(args.state_dir, args.unit_prefix):
            log("seller restarted active; failover complete")
            sys.exit(0)
        log(f"WARN: seller not active after switch to {url}; next timer run will retry")
        sys.exit(1)
    log("no healthy replacement RPC found; keeping current config")
    sys.exit(1)


if __name__ == "__main__":
    main()
