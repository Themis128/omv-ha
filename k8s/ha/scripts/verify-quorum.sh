#!/bin/bash
# Verify 3-node etcd quorum after witness joins
# Run on omv-main
set -euo pipefail

K3S_DATA_DIR="/srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s"
ETCDCTL="k3s etcd-snapshot"

echo "═══════════════════════════════════════════"
echo "  Cloudless Cluster Quorum Verification"
echo "═══════════════════════════════════════════"
echo ""

echo "── k8s Nodes ──────────────────────────────"
kubectl get nodes -o wide
echo ""

echo "── etcd Members ───────────────────────────"
ETCDCTL_API=3 k3s kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l component=etcd -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "etcd-omv") \
  -- etcdctl member list \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
  --cert=/var/lib/rancher/k3s/server/tls/etcd/server-client.crt \
  --key=/var/lib/rancher/k3s/server/tls/etcd/server-client.key \
  2>/dev/null || \
  echo "(etcdctl not directly accessible — check 'kubectl get nodes' instead)"
echo ""

echo "── Snapshot List ──────────────────────────"
k3s etcd-snapshot ls --data-dir "${K3S_DATA_DIR}" 2>/dev/null | tail -5
echo ""

echo "── WireGuard Status ────────────────────────"
wg show wg0 2>/dev/null || echo "WireGuard not configured yet"
echo ""

echo "── Quorum Assessment ───────────────────────"
NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
READY_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | grep -c " Ready" || echo 0)

echo "Total nodes:  ${NODE_COUNT}"
echo "Ready nodes:  ${READY_COUNT}"

if [ "${NODE_COUNT}" -ge 3 ] && [ "${READY_COUNT}" -ge 2 ]; then
  echo "✅ QUORUM HEALTHY — cluster survives 1 node failure"
elif [ "${NODE_COUNT}" -eq 2 ]; then
  echo "⚠️  2-node cluster — witness not yet joined"
else
  echo "🔴 QUORUM AT RISK"
fi
