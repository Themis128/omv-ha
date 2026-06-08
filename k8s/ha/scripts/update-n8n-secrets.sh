#!/usr/bin/env bash
# update-n8n-secrets.sh
#
# Run from a machine with kubectl access (after Tailscale SSH is configured)
# to update n8n cluster secrets after browser-based credential rotation.
#
# Rotated in browser (console.anthropic.com, notion.so, api.slack.com):
#   ANTHROPIC_API_KEY, NOTION_API_TOKEN, SLACK_WEBHOOK_URL
# Generated locally:
#   N8N_ENCRYPTION_KEY (openssl rand -hex 32)
#
# Usage:
#   bash update-n8n-secrets.sh \
#     --anthropic-key "sk-ant-api03-..." \
#     --notion-token  "ntn_..." \
#     --slack-webhook "https://hooks.slack.com/services/..." \
#     [--new-encryption-key]   # rotate N8N_ENCRYPTION_KEY (requires n8n data migration!)
#
# ⚠️  Rotating N8N_ENCRYPTION_KEY will break existing n8n credential storage.
#     All credentials in n8n must be re-entered after rotating this key.
#     Only do this if the old key was exposed.

set -euo pipefail

NAMESPACE="n8n"
SECRET_NAME="n8n-secrets"
ANTHROPIC_KEY=""
NOTION_TOKEN=""
SLACK_WEBHOOK=""
NEW_ENCRYPTION_KEY=false

usage() {
  echo "Usage: $0 --anthropic-key KEY --notion-token TOKEN --slack-webhook URL [--new-encryption-key]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --anthropic-key)      ANTHROPIC_KEY="$2";    shift 2 ;;
    --notion-token)       NOTION_TOKEN="$2";     shift 2 ;;
    --slack-webhook)      SLACK_WEBHOOK="$2";    shift 2 ;;
    --new-encryption-key) NEW_ENCRYPTION_KEY=true; shift ;;
    -h|--help)            usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$ANTHROPIC_KEY" || -z "$NOTION_TOKEN" || -z "$SLACK_WEBHOOK" ]] && usage

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v kubectl &>/dev/null || { echo "❌ kubectl not found — run from a machine with cluster access"; exit 1; }

echo "=== Updating n8n cluster secrets ==="
echo ""

# Check cluster reachability
if ! kubectl get namespace "${NAMESPACE}" &>/dev/null; then
  echo "❌ Cannot reach cluster or namespace '${NAMESPACE}' not found"
  exit 1
fi

# ── Read existing encryption key (unless rotating) ───────────────────────────
if [[ "$NEW_ENCRYPTION_KEY" == "true" ]]; then
  echo "⚠️  --new-encryption-key set: generating a NEW encryption key."
  echo "   All n8n stored credentials will break and must be re-entered."
  read -r -p "   Type 'yes' to confirm: " CONFIRM
  [[ "$CONFIRM" != "yes" ]] && { echo "Aborted."; exit 1; }
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  echo "   New encryption key generated."
else
  # Reuse existing key
  ENCRYPTION_KEY=$(kubectl get secret "${SECRET_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.data.N8N_ENCRYPTION_KEY}' 2>/dev/null | base64 -d || echo "")
  if [[ -z "$ENCRYPTION_KEY" ]]; then
    echo "⚠️  Could not read existing N8N_ENCRYPTION_KEY — generating new one."
    echo "   (This means either the secret doesn't exist yet, or it has no encryption key field.)"
    ENCRYPTION_KEY=$(openssl rand -hex 32)
  else
    echo "Reusing existing N8N_ENCRYPTION_KEY (not rotated)."
  fi
fi

# ── Apply updated secret ──────────────────────────────────────────────────────
echo ""
echo "Applying updated secret to ${NAMESPACE}/${SECRET_NAME}..."

kubectl create secret generic "${SECRET_NAME}" \
  --namespace "${NAMESPACE}" \
  --from-literal=N8N_ENCRYPTION_KEY="${ENCRYPTION_KEY}" \
  --from-literal=NOTION_API_TOKEN="${NOTION_TOKEN}" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_KEY}" \
  --from-literal=SLACK_WEBHOOK_URL="${SLACK_WEBHOOK}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Clear sensitive values from shell
unset ENCRYPTION_KEY ANTHROPIC_KEY NOTION_TOKEN SLACK_WEBHOOK

echo ""
echo "✅ Secret updated."
echo ""
echo "Restarting n8n deployment to pick up new values..."
kubectl rollout restart deployment/n8n -n "${NAMESPACE}" 2>/dev/null \
  && kubectl rollout status deployment/n8n -n "${NAMESPACE}" --timeout=120s \
  || echo "⚠️  n8n deployment restart failed — check: kubectl get pods -n ${NAMESPACE}"

echo ""
echo "════════════════════════════════════════"
echo "  n8n secrets updated."
echo "  Verify n8n is running:"
echo "    kubectl get pods -n ${NAMESPACE}"
echo "    kubectl logs -n ${NAMESPACE} deployment/n8n --tail=20"
echo "════════════════════════════════════════"
