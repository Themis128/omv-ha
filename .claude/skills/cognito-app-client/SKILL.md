---
name: cognito-app-client
description: >
  Manage Cognito app clients and diagnose authentication failures for cloudless.gr.
  Create new clients, update OAuth callback URLs, rotate secrets (confidential clients only),
  diagnose JWT validation errors, and trace auth flow failures.
  Use when login is broken, a new app needs Cognito auth, or callback URLs change.
argument-hint: "[diagnose | update-callbacks | create | rotate-secret | token-inspect <jwt>]"
allowed-tools: Bash, Read
---

# Cognito App Client Skill

Manages app clients and traces auth failures for the cloudless.gr Cognito User Pool (`us-east-1`).

## Step 0 — Setup

```bash
POOL_ID="${COGNITO_POOL_ID:-us-east-1_XXXXXXXXX}"
CLIENT_ID="${COGNITO_CLIENT_ID:-XXXXXXXXXXXXXXXXXXXXXXXXXX}"
REGION="us-east-1"
PROFILE="admin"
```

---

## Actions

### `diagnose` — Trace why login is failing

Run all checks in sequence. Stop and report at the first failure.

**Check 1 — App client exists and is enabled:**
```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPoolClient.{Name:ClientName,Flows:ExplicitAuthFlows,Callbacks:CallbackURLs,Scopes:AllowedOAuthScopes}' \
  --output json
```

**Check 2 — Verify callback URL is registered:**

The Next.js app uses NextAuth.js with Cognito provider. The callback URL pattern is:
`https://cloudless.gr/api/auth/callback/cognito`

```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPoolClient.CallbackURLs'
```

If `https://cloudless.gr/api/auth/callback/cognito` is missing → auth redirects will fail
with `redirect_mismatch` error. Fix: add it (see `update-callbacks` action).

**Check 3 — Auth flows include ALLOW_USER_SRP_AUTH:**
```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPoolClient.ExplicitAuthFlows'
```

Next.js/NextAuth with Cognito requires: `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`.
Optional: `ALLOW_USER_PASSWORD_AUTH` (if using username+password directly — less secure than SRP).

**Check 4 — Hosted UI domain configured (if using hosted UI flow):**
```bash
aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPool.Domain'
```

If null and the app uses `signIn()` with Cognito hosted UI → login page won't load.
Domain must be set before OAuth flows can work.

**Check 5 — Pool is not in error state:**
```bash
aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPool.Status'
```
Expected: `Active`. Any other value → pool is suspended or being deleted.

**Check 6 — Lambda triggers not throwing errors (last 30 min):**
```bash
# Get trigger Lambda names first
TRIGGERS=$(aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPool.LambdaConfig' --output json)

echo "$TRIGGERS"
# For each Lambda in the config, check its recent error rate:
# aws cloudwatch get-metric-statistics --namespace AWS/Lambda \
#   --metric-name Errors --dimensions Name=FunctionName,Value=<name> \
#   --start-time ... --end-time ... --period 300 --statistics Sum
```

---

### `update-callbacks <url1> [url2 ...]` — Add/update OAuth callback URLs

Gets the existing list, merges in the new URL(s), and applies the update.

```bash
NEW_URL="https://cloudless.gr/api/auth/callback/cognito"

# Get existing callback + logout URLs
EXISTING=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPoolClient' --output json)

CURRENT_CALLBACKS=$(echo "$EXISTING" | jq -r '.CallbackURLs[]')
CURRENT_LOGOUTS=$(echo "$EXISTING" | jq -r '.LogoutURLs[]')

# Merge new URL into existing list (deduplicated)
ALL_CALLBACKS=$(echo -e "${CURRENT_CALLBACKS}\n${NEW_URL}" | sort -u | jq -Rs 'split("\n") | map(select(length > 0))')

echo "Updating callback URLs to: $ALL_CALLBACKS"

# Build the update-user-pool-client command preserving all existing settings
aws cognito-idp update-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --callback-urls $(echo "$ALL_CALLBACKS" | jq -r '.[]' | tr '\n' ' ') \
  --logout-urls $(echo "$CURRENT_LOGOUTS" | tr '\n' ' ') \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --supported-identity-providers COGNITO
```

⚠️ `update-user-pool-client` overwrites ALL fields — always fetch existing config first
and replay unchanged fields. Omitting a field resets it to empty/default.

---

### `create <name> [--public | --confidential]` — Create a new app client

**Public client** (default — for Next.js SPA/SSR, no client secret):
```bash
NAME="cloudless-nextjs"
aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name "$NAME" \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-urls "https://cloudless.gr/api/auth/callback/cognito" \
  --logout-urls "https://cloudless.gr" \
  --supported-identity-providers COGNITO \
  --prevent-user-existence-errors ENABLED \
  --enable-token-revocation \
  --access-token-validity 1 \
  --id-token-validity 1 \
  --refresh-token-validity 30 \
  --token-validity-units AccessToken=hours,IdToken=hours,RefreshToken=days \
  --region "$REGION" --profile "$PROFILE" \
  | jq '{client_id: .UserPoolClient.ClientId, name: .UserPoolClient.ClientName}'
```

**Confidential client** (server-to-server, Lambda, or M2M — generates a secret):
```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name "${NAME}-server" \
  --generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --region "$REGION" --profile "$PROFILE" \
  | jq '{client_id: .UserPoolClient.ClientId, client_secret: .UserPoolClient.ClientSecret}'
```

Store the client secret immediately in AWS Secrets Manager or SSM — it is only shown once.

---

### `rotate-secret <client-id>` — Rotate app client secret (confidential clients only)

Public clients have no secret to rotate. For confidential clients:

```bash
TARGET_CLIENT_ID="$1"

# Cognito does not support in-place secret rotation — you must create a new client
# and update all consumers before deleting the old one.

echo "Cognito client secrets cannot be rotated in-place."
echo "Procedure:"
echo "1. Create a new client: cognito-app-client create ${NAME}-v2 --confidential"
echo "2. Update all consumers (Lambda env vars, Secrets Manager) to the new client_id + secret"
echo "3. Verify auth works with the new client"
echo "4. Delete the old client:"
echo "   aws cognito-idp delete-user-pool-client --user-pool-id $POOL_ID --client-id $TARGET_CLIENT_ID"
```

---

### `token-inspect <jwt>` — Decode and validate a Cognito JWT

Inspect a JWT from Cognito without verifying the signature (for debugging only):

```bash
JWT="$1"

# Decode header and payload (no signature verification)
HEADER=$(echo "$JWT" | cut -d. -f1 | base64 -d 2>/dev/null || echo "$JWT" | cut -d. -f1 | python3 -c "import sys,base64; d=sys.stdin.read().strip(); print(base64.b64decode(d + '=='*((4-len(d)%4)%4)).decode())")
PAYLOAD=$(echo "$JWT" | cut -d. -f2 | base64 -d 2>/dev/null || echo "$JWT" | cut -d. -f2 | python3 -c "import sys,base64; d=sys.stdin.read().strip(); print(base64.b64decode(d + '=='*((4-len(d)%4)%4)).decode())")

echo "=== Header ==="
echo "$HEADER" | jq .
echo "=== Payload ==="
echo "$PAYLOAD" | jq .

# Check expiry
EXP=$(echo "$PAYLOAD" | jq '.exp')
NOW=$(date +%s)
if [ "$EXP" -lt "$NOW" ]; then
  echo "⚠️  TOKEN EXPIRED (exp: $(date -d @$EXP 2>/dev/null || date -r $EXP), now: $(date))"
else
  echo "✅ Token valid until: $(date -d @$EXP 2>/dev/null || date -r $EXP)"
fi
```

Key claims to check:
- `iss`: must be `https://cognito-idp.us-east-1.amazonaws.com/<POOL_ID>`
- `aud` (ID token) or `client_id` (access token): must match your `CLIENT_ID`
- `token_use`: `id` or `access`
- `cognito:groups`: user's group memberships
- `exp`: expiry timestamp

---

## Common auth failure patterns

| Symptom | Cause | Fix |
|---|---|---|
| `redirect_mismatch` | Callback URL not in client's allowed list | `update-callbacks` action |
| `invalid_client` | Wrong CLIENT_ID in app env | Verify `NEXT_PUBLIC_COGNITO_CLIENT_ID` matches pool |
| `NotAuthorizedException: User does not exist` | Username enumeration prevention | Check user exists with `/cognito-users` |
| `UserNotConfirmedException` | Email not verified | `cognito-user-ops confirm <email>` |
| JWT `invalid_signature` | Wrong JWKS endpoint | Verify `iss` matches pool region+ID |
| JWT expired | Token not refreshed | Check NextAuth session refresh interval; extend refresh token TTL if needed |
| `invalid_grant` | Refresh token expired or revoked | User must re-authenticate; check refresh token TTL (default 30d) |
| Login works but groups missing | PreTokenGeneration Lambda not firing | Check Lambda trigger config and CloudWatch logs |
