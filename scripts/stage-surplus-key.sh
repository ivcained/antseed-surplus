#!/bin/bash
# stage-surplus-key: stage a replacement Surplus INFERENCE key for auto-rotation.
# Run on the seller host as root. Paste blind: the key never echoes and never
# lands in shell history. The key watchdog (antseed-key-watchdog.timer) promotes
# the staged key automatically when the current key's credit hits the threshold.
set -u
STATE_DIR="${ANTSEED_STATE_DIR:-/opt/antseed-surplus/.state}"
read -rsp "Paste new Surplus key (inf_...): " k
echo
case "$k" in
  inf_admin_*|si_seller_*) echo "REJECTED: that is an admin/seller key. Need a plain inference key (inf_...)."; exit 1;;
  inf_*) printf 'SURPLUS_API_KEY=%s\n' "$k" > "$STATE_DIR/surplus-key-next.env"
         chmod 600 "$STATE_DIR/surplus-key-next.env"
         unset k
         echo "STAGED at $STATE_DIR/surplus-key-next.env (mode 600)."
         echo "The key watchdog checks every 5 min and promotes this key automatically"
         echo "when the current key's credit drops to the threshold. Nothing restarts until then.";;
  *) echo "REJECTED: key must start with inf_"; exit 1;;
esac
