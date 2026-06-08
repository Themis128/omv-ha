#!/usr/bin/env bash
# create-ntfy-basic-auth.sh
#
# Creates (or rotates) the basic-auth password Alertmanager uses to push to the
# self-hosted ntfy relay. Replaces the old inline password in
# kube-prometheus-stack-values.yaml (security violation — see CLAUDE.md).
#
# Alertmanager reads this via password_file:
#   /etc/alertmanager/secrets/ntfy-basic-auth/password
# (mounted by alertmanagerSpec.secrets: [ntfy-basic-auth])
#
# The SAME password must be set on the ntfy side for user `alertmanager`, or
# Alertmanager's POST /alerts will get 401. The reminder is printed at the end.
#
# Usage:
#   bash k8s/monitoring/scripts/create-ntfy-basic-auth.sh                 # random password
#   NTFY_PASSWORD=... bash k8s/monitoring/scripts/create-ntfy-basic-auth.sh   # pin a value
set -euo pipefail

NS="monitoring"
KUBECTL="${KUBECTL:-kubectl}"
NTFY_USER="${NTFY_USER:-alertmanager}"
NTFY_PASSWORD="${NTFY_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)}"

echo "Ensuring namespace ${NS} exists..."
$KUBECTL get namespace "$NS" >/dev/null 2>&1 || $KUBECTL create namespace "$NS"

# Key MUST be `password` to match password_file path .../ntfy-basic-auth/password
$KUBECTL create secret generic ntfy-basic-auth -n "$NS" \
  --from-literal=password="${NTFY_PASSWORD}" \
  --dry-run=client -o yaml | $KUBECTL apply -f -

echo ""
echo "✅ Secret monitoring/ntfy-basic-auth applied (key: password)."
echo ""
echo "Now set the SAME password for user '${NTFY_USER}' on the ntfy server:"
echo "  kubectl exec -n ntfy deploy/ntfy -- \\"
echo "    ntfy user add --role=user ${NTFY_USER} <<<'${NTFY_PASSWORD}'   # or 'ntfy user change-pass ${NTFY_USER}'"
echo "  kubectl exec -n ntfy deploy/ntfy -- ntfy access ${NTFY_USER} alerts rw"
echo ""
echo "Then restart Alertmanager to mount the new secret:"
echo "  kubectl rollout restart -n ${NS} statefulset/alertmanager-kube-prom-kube-prometheus-stack-alertmanager"
