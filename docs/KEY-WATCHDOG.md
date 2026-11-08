# Key auto-rotation watchdog

The seller buys inference with a prepaid Surplus `inf_` key. When that key's
credit runs dry the seller starts answering 402s. This watchdog (systemd
timer, every 5 minutes) checks the credit of the current key and, when it
falls to/below the threshold (default $0.05), promotes a staged replacement
key and restarts the seller and monitor — rotation without operator action.

```
.state/surplus-key-next.env  ->  .state/surplus-key.env
(previous key archived as .state/surplus-key.previous-<stamp>.env)
```

## Stage a replacement key

Run the helper **on the seller host** and paste blind; the key never echoes
and never lands in shell history:

```sh
sudo install -m 755 scripts/stage-surplus-key.sh /usr/local/bin/stage-surplus-key
stage-surplus-key
```

Keys are validated (`inf_` prefix; admin and seller keys rejected) and stored
mode 0600. Nothing restarts until the threshold fires.

## Install

```sh
sudo install -m 700 scripts/key-watchdog.py /opt/antseed-surplus/scripts-ops/key-watchdog.py
sudo install -m 644 scripts/systemd/antseed-key-watchdog.service scripts/systemd/antseed-key-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antseed-key-watchdog.timer
```

Defaults assume the documented deployment; override with `--state-dir`,
`--log`, `--unit-prefix`, or `--threshold-micros`.

## Notes

- Surplus credit is scoped per key/workspace: after staging, verify the
  staged key's own balance; a key from an unfunded workspace adds nothing.
- Secrets never appear in logs — only key prefixes/suffixes, balances and
  decisions. The previous key is archived locally, not deleted; revoke it on
  the Surplus dashboard once you no longer need it.
