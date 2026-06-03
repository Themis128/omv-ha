#!/usr/bin/env bash
# Create monitoring namespace secrets that are referenced by Helm values
# but not stored in the repo. Run once before the first `helm upgrade`.
#
# Usage: bash k8s/ha/scripts/setup-monitoring-secrets.sh
set -euo pipefail

NAMESPACE="monitoring"

# ── Grafana admin credentials ────────────────────────────────────────────────
# Referenced by kube-prometheus-stack-values.yaml: grafana.admin.existingSecret
if kubectl get secret grafana-admin-credentials -n "${NAMESPACE}" &>/dev/null; then
  echo "INFO: grafana-admin-credentials already exists — skipping"
else
  read -r -s -p "Grafana admin password: " GRAFANA_PASSWORD
  echo
  kubectl create secret generic grafana-admin-credentials \
    -n "${NAMESPACE}" \
    --from-literal=admin-user=admin \
    --from-literal=admin-password="${GRAFANA_PASSWORD}"
  unset GRAFANA_PASSWORD
  echo "INFO: grafana-admin-credentials created"
fi

echo ""
echo "Done. You can now run:"
echo "  helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack \\"
echo "    -n monitoring --create-namespace \\"
echo "    -f k8s/monitoring/kube-prometheus-stack-values.yaml"
