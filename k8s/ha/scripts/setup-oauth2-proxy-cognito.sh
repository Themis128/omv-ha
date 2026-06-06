#!/usr/bin/env bash
# setup-oauth2-proxy-cognito.sh
#
# Wires oauth2-proxy to use Cognito OIDC for manage.cloudless.online.
# Creates the dedicated Cognito app client, k8s ConfigMap, k8s Secret,
# and applies the deployment in one shot.
#
# Prerequisites:
#   - AWS_PROFILE=admin (or credentials in environment)
#   - kubectl configured with access to the cluster
#   - jq installed
#
# Usage:
#   AWS_PROFILE=admin bash k8s/ha/scripts/setup-oauth2-proxy-cognito.sh
#
#   # Skip Cognito client creation (client already exists):
#   SKIP_CLIENT_CREATE=1 COGNITO_CLIENT_ID=<id> COGNITO_CLIENT_SECRET=<secret> \
#     AWS_PROFILE=admin bash k8s/ha/scripts/setup-oauth2-proxy-cognito.sh

set -euo pipefail

PROFILE="${AWS_PROFILE:-admin}"
REGION="us-east-1"
POOL_NAME="${POOL_NAME:-cloudless-auth}"
COGNITO_DOMAIN="https://cloudless-auth.auth.us-east-1.amazoncognito.com"
CALLBACK_URL="https://manage.cloudless.online/oauth2/callback"
LOGOUT_URL="https://manage.cloudless.online"

# ─── Step 1: Resolve Pool ID ──────────────────────────────────────────────────
if [[ -n "${COGNITO_POOL_ID:-}" ]]; then
  POOL_ID="$COGNITO_POOL_ID"
  echo "ℹ️  Using COGNITO_POOL_ID from environment: $POOL_ID"
else
  echo "🔍 Looking up Cognito pool by name '$POOL_NAME'..."

  # Try SSM first (populated by wire-pi-cognito.sh / SST deploy)
  POOL_ID=$(aws ssm get-parameter \
    --name "/cloudless/production/COGNITO_USER_POOL_ID" \
    --region "$REGION" --profile "$PROFILE" \
    --query 'Parameter.Value' --output text 2>/dev/null || true)

  # Fall back to listing pools by name
  if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
    POOL_ID=$(aws cognito-idp list-user-pools \
      --max-results 20 \
      --region "$REGION" --profile "$PROFILE" \
      --query "UserPools[?Name=='${POOL_NAME}'].Id" \
      --output text 2>/dev/null || true)
  fi

  if [[ -z "$POOL_ID" || "$POOL_ID" == "None" ]]; then
    echo "❌ Could not determine Pool ID automatically."
    echo "   Run with: COGNITO_POOL_ID=us-east-1_XXXXXXXXX bash $0"
    exit 1
  fi
  echo "✅ Pool ID: $POOL_ID"
fi

OIDC_ISSUER_URL="https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}"

# ─── Step 2: Create / reuse Cognito app client ───────────────────────────────
if [[ "${SKIP_CLIENT_CREATE:-}" == "1" ]]; then
  CLIENT_ID="${COGNITO_CLIENT_ID:?Set COGNITO_CLIENT_ID when SKIP_CLIENT_CREATE=1}"
  CLIENT_SECRET="${COGNITO_CLIENT_SECRET:?Set COGNITO_CLIENT_SECRET when SKIP_CLIENT_CREATE=1}"
  echo "ℹ️  Skipping client creation, using CLIENT_ID=$CLIENT_ID"
else
  EXISTING=$(aws cognito-idp list-user-pool-clients \
    --user-pool-id "$POOL_ID" \
    --region "$REGION" --profile "$PROFILE" \
    --query "UserPoolClients[?ClientName=='cloudless-oauth2-proxy'].ClientId" \
    --output text 2>/dev/null || true)

  if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
    echo "⚠️  Client 'cloudless-oauth2-proxy' already exists: $EXISTING"
    echo "   Cannot retrieve its secret after creation (AWS limitation)."
    echo "   To rotate: run docs/key-rotation.md § 6 procedure."
    echo "   To reuse: SKIP_CLIENT_CREATE=1 COGNITO_CLIENT_ID=$EXISTING COGNITO_CLIENT_SECRET=<secret> bash $0"
    exit 1
  fi

  echo "🔧 Creating Cognito app client 'cloudless-oauth2-proxy'..."
  CLIENT_JSON=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "cloudless-oauth2-proxy" \
    --generate-secret \
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes openid email profile \
    --allowed-o-auth-flows-user-pool-client \
    --callback-urls "$CALLBACK_URL" \
    --logout-urls "$LOGOUT_URL" \
    --supported-identity-providers COGNITO \
    --prevent-user-existence-errors ENABLED \
    --enable-token-revocation \
    --access-token-validity 1 \
    --id-token-validity 1 \
    --refresh-token-validity 30 \
    --token-validity-units AccessToken=hours,IdToken=hours,RefreshToken=days \
    --region "$REGION" --profile "$PROFILE" \
    --output json)

  CLIENT_ID=$(echo "$CLIENT_JSON" | jq -r '.UserPoolClient.ClientId')
  CLIENT_SECRET=$(echo "$CLIENT_JSON" | jq -r '.UserPoolClient.ClientSecret')
  echo "✅ Created client: $CLIENT_ID"
  echo ""
  echo "  ⚠️  Save these values now — the secret cannot be retrieved again:"
  echo "     Client ID:     $CLIENT_ID"
  echo "     Client Secret: $CLIENT_SECRET"
  echo ""
fi

# ─── Step 3: Create k8s ConfigMap (non-secret Cognito config) ────────────────
echo "🔧 Creating oauth2-proxy-config ConfigMap..."
kubectl create configmap oauth2-proxy-config \
  --from-literal=oidc_issuer_url="$OIDC_ISSUER_URL" \
  --from-literal=client_id="$CLIENT_ID" \
  --from-literal=cognito_domain="$COGNITO_DOMAIN" \
  -n cloudless \
  --dry-run=client -o yaml | kubectl apply -f -
echo "✅ ConfigMap updated"

# ─── Step 4: Create k8s Secret (client secret + cookie secret) ───────────────
echo "🔧 Creating oauth2-proxy-secret..."

# Preserve existing cookie secret if already set
EXISTING_COOKIE=$(kubectl get secret oauth2-proxy-secret -n cloudless \
  -o jsonpath='{.data.cookie-secret}' 2>/dev/null | base64 -d 2>/dev/null || true)

if [[ -z "$EXISTING_COOKIE" ]]; then
  COOKIE_SECRET=$(openssl rand -base64 32 | tr -d '\n')
  echo "ℹ️  Generated new cookie secret (all existing sessions will be invalidated)"
else
  COOKIE_SECRET="$EXISTING_COOKIE"
  echo "ℹ️  Preserving existing cookie secret"
fi

kubectl create secret generic oauth2-proxy-secret \
  --from-literal=client-secret="$CLIENT_SECRET" \
  --from-literal=cookie-secret="$COOKIE_SECRET" \
  -n cloudless \
  --dry-run=client -o yaml | kubectl apply -f -
echo "✅ Secret updated"

# ─── Step 5: Apply deployment ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YAML_FILE="$SCRIPT_DIR/../../cloudless/oauth2-proxy.yaml"

echo "🚀 Applying oauth2-proxy deployment..."
kubectl apply -f "$YAML_FILE"
kubectl rollout restart deployment/oauth2-proxy -n cloudless
kubectl rollout status deployment/oauth2-proxy -n cloudless --timeout=120s

# ─── Step 6: Smoke test ───────────────────────────────────────────────────────
echo ""
echo "✅ oauth2-proxy deployed with Cognito OIDC"
echo "   Pool ID:      $POOL_ID"
echo "   Issuer URL:   $OIDC_ISSUER_URL"
echo "   Client ID:    $CLIENT_ID"
echo ""
echo "  Test:    curl -I https://manage.cloudless.online  (expect 302 → Cognito)"
echo "  Browser: https://manage.cloudless.online"
echo ""
echo "Remaining cleanup:"
echo "  kubectl delete namespace keycloak         # remove live Keycloak resources"
echo "  # Remove auth.cloudless.online CNAME in Cloudflare dashboard"
