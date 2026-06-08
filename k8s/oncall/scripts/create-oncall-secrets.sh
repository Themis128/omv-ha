#!/usr/bin/env bash
# create-oncall-secrets.sh
#
# Creates (or rotates) all OnCall backing-service secrets WITHOUT storing any
# password literal in the repo. Replaces the old k8s/oncall/deps.yaml, which
# committed plaintext passwords (security violation — see CLAUDE.md secret hygiene).
#
# Three logical credentials, kept consistent across the secrets that consume them:
#   DB_PASSWORD       — MariaDB user `oncall` password == password OnCall connects with
#   DB_ROOT_PASSWORD  — MariaDB root password
#   REDIS_PASSWORD    — Redis AUTH password
#
# Secrets created:
#   oncall-mariadb-secret   (consumed by the MariaDB StatefulSet)
#     MYSQL_PASSWORD       = $DB_PASSWORD
#     MYSQL_ROOT_PASSWORD  = $DB_ROOT_PASSWORD
#   oncall-mysql-external   (consumed by the OnCall Helm chart, externalMysql.existingSecret)
#     mariadb-root-password = $DB_PASSWORD   # chart's key name; value is the oncall-user password
#   oncall-redis-external   (consumed by the OnCall Helm chart, externalRedis.existingSecret)
#     redis-password        = $REDIS_PASSWORD
#
# Usage:
#   # Generate fresh random passwords (recommended — rotation):
#   bash k8s/oncall/scripts/create-oncall-secrets.sh
#
#   # Or pin specific values (e.g. to match an already-initialised MariaDB volume):
#   DB_PASSWORD=... DB_ROOT_PASSWORD=... REDIS_PASSWORD=... \
#     bash k8s/oncall/scripts/create-oncall-secrets.sh
#
# NOTE: If the MariaDB PVC already exists, MariaDB will NOT re-read MYSQL_PASSWORD
# on restart — you must ALTER USER inside the running DB to match, or wipe the PVC.
# See the rotation runbook printed at the end.
set -euo pipefail

NS="oncall"
KUBECTL="${KUBECTL:-kubectl}"

gen() { openssl rand -base64 24 | tr -d '/+=' | head -c 28; }

DB_PASSWORD="${DB_PASSWORD:-$(gen)}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-$(gen)}"
REDIS_PASSWORD="${REDIS_PASSWORD:-$(gen)}"

echo "Ensuring namespace ${NS} exists..."
$KUBECTL get namespace "$NS" >/dev/null 2>&1 || $KUBECTL create namespace "$NS"

apply_secret() {
  # apply_secret <name> <key1=val1> [<key2=val2> ...]
  local name="$1"; shift
  local args=()
  for kv in "$@"; do args+=(--from-literal="$kv"); done
  $KUBECTL create secret generic "$name" -n "$NS" "${args[@]}" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
}

apply_secret oncall-mariadb-secret \
  "MYSQL_PASSWORD=${DB_PASSWORD}" \
  "MYSQL_ROOT_PASSWORD=${DB_ROOT_PASSWORD}"

apply_secret oncall-mysql-external \
  "mariadb-root-password=${DB_PASSWORD}"

apply_secret oncall-redis-external \
  "redis-password=${REDIS_PASSWORD}"

echo ""
echo "✅ Secrets applied to namespace ${NS}:"
echo "   oncall-mariadb-secret, oncall-mysql-external, oncall-redis-external"
echo ""
echo "If this is a ROTATION on a running cluster (PVCs already exist), the new"
echo "passwords won't take effect until the backing services adopt them:"
echo ""
echo "  # MariaDB — update the live user passwords to match the new secret:"
echo "  kubectl exec -n ${NS} sts/oncall-mariadb -- \\"
echo "    mariadb -uroot -p'<OLD_ROOT_PW>' -e \\"
echo "    \"ALTER USER 'oncall'@'%' IDENTIFIED BY '${DB_PASSWORD}'; \\"
echo "     ALTER USER 'root'@'%' IDENTIFIED BY '${DB_ROOT_PASSWORD}'; FLUSH PRIVILEGES;\""
echo ""
echo "  # Redis — requirepass change needs a pod restart (re-reads secret via env):"
echo "  kubectl rollout restart -n ${NS} statefulset/oncall-redis"
echo ""
echo "  # Then restart OnCall to pick up new connection creds:"
echo "  kubectl rollout restart -n ${NS} deployment/oncall-engine deployment/oncall-celery"
