#!/bin/bash
# Run on omv-main to enable etcd → S3 snapshots
# k3s has native S3 snapshot support — no extra tooling needed.
# Uses IMDSv2 (instance role) on EC2 witness; uses explicit keys on Pi nodes.
#
# Usage: sudo bash enable-s3-snapshots.sh
set -euo pipefail

K3S_DATA_DIR="/srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s"
K3S_CONFIG="/etc/rancher/k3s/config.yaml"
BUCKET="cloudless-etcd-snapshots"
REGION="us-east-1"

# ── Prompt for AWS credentials (omv-main-cli IAM user) ──────────────────────
read -rsp "AWS Access Key ID (omv-main-cli): " AWS_KEY
echo
read -rsp "AWS Secret Access Key: " AWS_SECRET
echo

# ── Backup existing config ───────────────────────────────────────────────────
cp "${K3S_CONFIG}" "${K3S_CONFIG}.bak-$(date +%Y%m%d-%H%M%S)"

# ── Add S3 snapshot config to k3s config.yaml ───────────────────────────────
# k3s snapshot runs every 6h by default, keeps 5 snapshots on disk + all on S3
# We override: every 6h, retain 10 on S3, 3 on disk

cat >> "${K3S_CONFIG}" << EOF

# etcd S3 snapshots (added $(date +%Y-%m-%d))
etcd-snapshot-schedule-cron: "0 */6 * * *"   # every 6 hours
etcd-snapshot-retention: 3                    # local snapshots to keep
etcd-s3: true
etcd-s3-bucket: ${BUCKET}
etcd-s3-region: ${REGION}
etcd-s3-folder: etcd
etcd-s3-access-key: ${AWS_KEY}
etcd-s3-secret-key: ${AWS_SECRET}
etcd-s3-insecure: false
EOF

echo "✅ S3 snapshot config appended to ${K3S_CONFIG}"
echo ""
echo "Restarting k3s to apply..."
systemctl restart k3s

sleep 10

echo "Triggering immediate snapshot to verify S3 connectivity..."
k3s etcd-snapshot save --name "post-config-$(date +%Y%m%d-%H%M%S)" \
  --data-dir "${K3S_DATA_DIR}"

echo ""
echo "Listing snapshots (S3):"
k3s etcd-snapshot ls --data-dir "${K3S_DATA_DIR}"

echo ""
echo "✅ S3 snapshots active. Check bucket: s3://${BUCKET}/etcd/"
