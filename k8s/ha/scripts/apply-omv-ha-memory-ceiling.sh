#!/usr/bin/env bash
# Apply a systemd memory ceiling to k3s on omv-ha.
#
# Without this, Go's GC does not reclaim memory aggressively. During etcd member
# rejoin (every reboot), the k3s process grows to 2–3 GB and triggers an OOM kill
# on the 1 GB Pi 4. Setting MemoryHigh forces the GC to run before hitting the hard cap.
#
# Run once on omv-ha, then restart k3s.
set -euo pipefail

OVERRIDE_DIR=/etc/systemd/system/k3s.service.d
OVERRIDE_FILE="${OVERRIDE_DIR}/memory-ceiling.conf"

if [[ "$(hostname)" != "omv-ha" ]]; then
  echo "ERROR: this script must run on omv-ha" >&2
  exit 1
fi

mkdir -p "${OVERRIDE_DIR}"

cat > "${OVERRIDE_FILE}" <<'EOF'
[Service]
MemoryHigh=750M
MemoryMax=900M
EOF

systemctl daemon-reload
echo "Applied memory ceiling. Restart k3s to take effect:"
echo "  kubectl drain omv-ha --ignore-daemonsets --delete-emptydir-data"
echo "  systemctl restart k3s"
