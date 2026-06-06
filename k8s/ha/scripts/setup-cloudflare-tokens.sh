#!/usr/bin/env bash
# setup-cloudflare-tokens.sh
#
# Apply the two-token Cloudflare architecture after creating tokens in the dashboard.
#
# Token A (cert-manager-dns01) — Zone:DNS:Edit + Zone:Zone:Read, cloudless.gr only
#   → Stored as k8s Secret `cloudflare-api-token` in cert-manager namespace
#
# Token B (gh-actions-dns-lb) — Zone:DNS:Edit + Zone:Zone:Read + Zone:LB:Edit, cloudless.gr only
#   → Stored as GitHub Secret CLOUDFLARE_API_TOKEN
#
# Usage (run from a machine with kubectl + gh CLI access):
#   bash setup-cloudflare-tokens.sh \
#     --token-a "cfat_certmanager_token_value" \
#     --token-b "cfat_ghactions_token_value"
#
# Requires:
#   - kubectl configured to reach the cluster (or run via kubectl-dispatch workflow)
#   - gh CLI authenticated (for setting GitHub secret)
#
# To apply token A via kubectl-dispatch workflow instead:
#   Encode the token: echo -n "TOKEN_VALUE" | base64
#   Then use kubectl-dispatch.yml to run:
#     kubectl create secret generic cloudflare-api-token \
#       --namespace cert-manager \
#       --from-literal=api-token="TOKEN_VALUE" \
#       --dry-run=client -o yaml | kubectl apply -f -

set -euo pipefail

REPO="Themis128/omv-ha"

usage() {
  echo "Usage: $0 --token-a CERT_MANAGER_TOKEN --token-b GH_ACTIONS_TOKEN"
  echo ""
  echo "  --token-a   cert-manager-dns01 token (Zone:DNS:Edit + Zone:Zone:Read)"
  echo "  --token-b   gh-actions-dns-lb token  (Zone:DNS:Edit + Zone:Zone:Read + Zone:LB:Edit)"
  exit 1
}

TOKEN_A=""
TOKEN_B=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-a) TOKEN_A="$2"; shift 2 ;;
    --token-b) TOKEN_B="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$TOKEN_A" || -z "$TOKEN_B" ]] && usage

echo "=== Cloudflare two-token setup ==="
echo ""

# ── Token B → GitHub Secret ───────────────────────────────────────────────────
echo "1. Setting CLOUDFLARE_API_TOKEN GitHub secret (token B: gh-actions-dns-lb)..."
gh secret set CLOUDFLARE_API_TOKEN --repo "${REPO}" --body "${TOKEN_B}"
echo "   ✅ CLOUDFLARE_API_TOKEN updated"

# ── Verify token B ────────────────────────────────────────────────────────────
echo ""
echo "2. Verifying token B with Cloudflare API..."
VERIFY=$(curl -sf https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer ${TOKEN_B}" 2>/dev/null || echo '{"success":false}')
if [[ "$(echo "$VERIFY" | jq -r '.success')" == "true" ]]; then
  STATUS=$(echo "$VERIFY" | jq -r '.result.status')
  echo "   ✅ Token B verified — status: ${STATUS}"
else
  echo "   ❌ Token B verification failed: ${VERIFY}"
  exit 1
fi

# ── Token A → cert-manager k8s Secret ────────────────────────────────────────
echo ""
echo "3. Applying token A to cert-manager namespace (cloudflare-api-token secret)..."
if command -v kubectl &>/dev/null; then
  kubectl create secret generic cloudflare-api-token \
    --namespace cert-manager \
    --from-literal=api-token="${TOKEN_A}" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "   ✅ cloudflare-api-token secret applied in cert-manager namespace"
else
  echo "   ⚠️  kubectl not found — apply token A manually once you have cluster access:"
  echo ""
  echo "   kubectl create secret generic cloudflare-api-token \\"
  echo "     --namespace cert-manager \\"
  echo "     --from-literal=api-token=\"<token-a-value>\" \\"
  echo "     --dry-run=client -o yaml | kubectl apply -f -"
fi

# ── Verify cert-manager ClusterIssuer ────────────────────────────────────────
echo ""
echo "4. Checking cert-manager ClusterIssuer (letsencrypt-cloudflare)..."
if command -v kubectl &>/dev/null; then
  kubectl get clusterissuer letsencrypt-cloudflare -o jsonpath='{.status.conditions[0].message}' 2>/dev/null \
    && echo "" || echo "   ⚠️  ClusterIssuer not found — apply k8s/cert-manager/clusterissuer-cloudflare.yaml first"
else
  echo "   (skipped — no kubectl)"
fi

echo ""
echo "========================================================"
echo "  Done. Summary:"
echo "  ✅ CLOUDFLARE_API_TOKEN → token B (gh-actions-dns-lb)"
echo "  $(command -v kubectl &>/dev/null && echo '✅' || echo '⏸') cloudflare-api-token k8s secret → token A (cert-manager-dns01)"
echo "========================================================"
echo ""
echo "Next: set CLOUDFLARE_ZONE_ID repo variable at"
echo "  github.com/Themis128/omv-ha/settings/variables"
echo "  Value: find at dash.cloudflare.com → cloudless.gr → Overview (right sidebar)"
