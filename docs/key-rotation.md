# Crypto-Agility & Key Rotation Runbook

## Overview

Crypto-agility means the system can rotate keys and swap algorithms without downtime. This document covers rotation procedures for all cryptographic material in the cloudless stack.

| Material | Location | TTL / Rotation trigger |
|----------|----------|------------------------|
| k3s secret encryption key (AES-GCM) | `/var/lib/rancher/k3s/server/crypt/` | Manual / on compromise |
| ECR pull secret (`regcred-ecr`) | `cloudless` namespace | 12h TTL, auto-refreshed every 6h |
| Sync-webhook HMAC secret (`SYNC_HMAC_SECRET`) | `cloudless-app-config` secret | Manual / on compromise |
| Cloudflare API token | `cert-manager` secret | Manual / per policy |
| AWS IAM access key | GitHub Actions secrets | Every 90 days or on exposure |
| Cognito app client secret (oauth2-proxy) | `oauth2-proxy-secret` k8s secret | Manual / on compromise |

---

## 1. k3s Secret Encryption Key (AES-GCM)

k3s encrypts all Kubernetes secrets at rest using AES-GCM. The key lives at:
`/var/lib/rancher/k3s/server/crypt/`

### Rotate the encryption key

```bash
# On omv-main (primary node)
# 1. Generate new key and add it as first entry (k3s reads the first key for writes)
sudo k3s secrets-encrypt rotate-keys

# 2. Wait for rotation to propagate
sudo k3s secrets-encrypt status

# 3. Rewrite all secrets to disk with the new key
sudo k3s secrets-encrypt reencrypt --force

# 4. Verify
sudo k3s secrets-encrypt status
```

> k3s supports multiple keys at once (for reading old secrets). After reencrypt, old keys can be removed.

### Verify a secret is encrypted

```bash
# Hex dump of etcd data — should show encrypted blob, not plaintext
sudo ETCDCTL_API=3 etcdctl \
  --endpoints https://127.0.0.1:2379 \
  --cacert /var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
  --cert /var/lib/rancher/k3s/server/tls/etcd/client.crt \
  --key /var/lib/rancher/k3s/server/tls/etcd/client.key \
  get /registry/secrets/cloudless/cloudless-app-config | od -c | head -5
# Should show "k8s:enc:aescbc" or "k8s:enc:aesgcm" prefix, not plaintext
```

---

## 2. Sync-Webhook HMAC Secret

Used to authenticate `POST /_sync/image` and `POST /_sync/config` requests from GitHub Actions.

### Rotate

```bash
# 1. Generate new secret
NEW_SECRET=$(openssl rand -hex 32)
echo "New secret: $NEW_SECRET"  # save this before continuing

# 2. Update the k8s secret
kubectl get secret cloudless-app-config -n cloudless -o json \
  | jq --arg s "$(echo -n "$NEW_SECRET" | base64)" \
       '.data.SYNC_HMAC_SECRET = $s' \
  | kubectl apply -f -

# 3. Restart sync-webhook to pick up new value
kubectl rollout restart deployment/sync-webhook -n cloudless

# 4. Update GitHub Actions secret SYNC_HMAC_SECRET in repo settings:
#    Settings → Secrets and variables → Actions → SYNC_HMAC_SECRET
```

> The 300s replay window means old tokens are rejected within 5 minutes even without rotation.

---

## 3. ECR Pull Secret

Auto-rotated every 6 hours by `ecr-cred-refresher` CronJob. Manual rotation:

```bash
kubectl create job ecr-refresh-now --from=cronjob/ecr-cred-refresher -n cloudless
kubectl get secret regcred-ecr -n cloudless  # AGE should reset to <1m
```

---

## 4. Cloudflare API Token (cert-manager)

Used by cert-manager for DNS-01 ACME challenges.

```bash
# 1. Generate new token at dash.cloudflare.com → My Profile → API Tokens
# 2. Update the secret:
kubectl create secret generic cloudflare-api-token \
  --from-literal=api-token=<NEW_TOKEN> \
  -n cert-manager \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

## 5. AWS IAM Access Key

Used by GitHub Actions for deployments (e.g. ECR push, S3 sync, SES). Prefer OIDC over
long-lived keys — the `GitHubActionsOIDC` role already exists for this purpose.

### Automated rotation (preferred)

```bash
# 1. Grant the OIDC role permissions to manage keys (run once, needs AWS admin):
AWS_PROFILE=<admin> bash k8s/ha/scripts/grant-iam-key-rotation.sh

# 2. Run the rotation workflow from GitHub Actions UI:
#    Actions → Rotate AWS Access Key
#    Inputs: iam_username=<user>, old_key_id=AKIA..., dry_run=true (test first)

# 3. After confirming no errors for 14 days, re-run with delete_old_key=true
```

### Manual rotation

```bash
# Deactivate (reversible)
aws iam update-access-key \
  --user-name <username> \
  --access-key-id AKIA... \
  --status Inactive

# Create replacement
aws iam create-access-key --user-name <username>
# Store AccessKeyId + SecretAccessKey in GitHub secrets:
gh secret set AWS_ACCESS_KEY_ID     --body "AKIA..."
gh secret set AWS_SECRET_ACCESS_KEY --body "..."

# Audit usage before deleting (check last 90 days):
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=AKIA... \
  --query 'Events[*].{Time:EventTime,Event:EventName}' --output table

# Delete old key after 14-day wait
aws iam delete-access-key --user-name <username> --access-key-id AKIA...
```

---

## 6. Cognito App Client Secret (oauth2-proxy)

`oauth2-proxy` uses a dedicated confidential Cognito app client (separate from the public Next.js client).
Cognito does not support in-place secret rotation — create a new client and migrate.

### Rotate

```bash
POOL_ID="<from NEXT_PUBLIC_COGNITO_USER_POOL_ID secret>"
REGION="us-east-1"
PROFILE="admin"

# 1. Create a new confidential client
NEW_CLIENT=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name "cloudless-oauth2-proxy-v2" \
  --generate-secret \
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-urls "https://manage.cloudless.gr/oauth2/callback" \
  --logout-urls "https://manage.cloudless.gr" \
  --supported-identity-providers COGNITO \
  --region "$REGION" --profile "$PROFILE" \
  | jq '{client_id: .UserPoolClient.ClientId, client_secret: .UserPoolClient.ClientSecret}')

echo "$NEW_CLIENT"  # save both values immediately

NEW_CLIENT_ID=$(echo "$NEW_CLIENT" | jq -r .client_id)
NEW_CLIENT_SECRET=$(echo "$NEW_CLIENT" | jq -r .client_secret)

# 2. Update the k8s secret
kubectl create secret generic oauth2-proxy-secret \
  --from-literal=client-secret="$NEW_CLIENT_SECRET" \
  --from-literal=cookie-secret="$(kubectl get secret oauth2-proxy-secret -n cloudless -o jsonpath='{.data.cookie-secret}' | base64 -d)" \
  -n cloudless \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. Update the oauth2-proxy deployment with the new client-id
kubectl patch deployment oauth2-proxy -n cloudless --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/args/3\",\"value\":\"--client-id=$NEW_CLIENT_ID\"}]"
# NOTE: verify the arg index matches --client-id position in oauth2-proxy.yaml

# 4. Restart oauth2-proxy
kubectl rollout restart deployment/oauth2-proxy -n cloudless
kubectl rollout status deployment/oauth2-proxy -n cloudless

# 5. Verify login works at https://manage.cloudless.gr, then delete old client
OLD_CLIENT_ID="<previous client id>"
aws cognito-idp delete-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$OLD_CLIENT_ID" \
  --region "$REGION" --profile "$PROFILE"
```

### oauth2-proxy cookie secret rotation

The cookie secret encrypts session cookies. Rotating it invalidates all active sessions (users must re-login).

```bash
NEW_COOKIE_SECRET=$(openssl rand -base64 32 | tr -d '\n')

kubectl create secret generic oauth2-proxy-secret \
  --from-literal=client-secret="$(kubectl get secret oauth2-proxy-secret -n cloudless -o jsonpath='{.data.client-secret}' | base64 -d)" \
  --from-literal=cookie-secret="$NEW_COOKIE_SECRET" \
  -n cloudless \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/oauth2-proxy -n cloudless
```

---

## Rotation Schedule (recommended)

| Material | Frequency |
|----------|-----------|
| k3s encryption key | Annually or on any node compromise |
| HMAC secret | Every 90 days or on any webhook exposure |
| Cloudflare token | Every 90 days or on any CI/CD credential leak |
| ECR pull secret | Automatic (every 6h) |
| AWS IAM access key | Every 90 days or immediately on exposure |
| Cognito oauth2-proxy client | On any credential exposure or annually |

---

## Files

| Path | Description |
|------|-------------|
| `k8s/cloudless/ecr-cred-refresher.yaml` | ECR credential auto-rotation CronJob |
| `k8s/cloudless/auto-healer.yaml` | Detects ECR pull failures and triggers refresh |
| `k8s/cloudless/oauth2-proxy.yaml` | oauth2-proxy deployment (Cognito OIDC) |
| `k8s/ha/scripts/grant-iam-key-rotation.sh` | Grants OIDC role permissions for key rotation |
| `.github/workflows/rotate-aws-key.yml` | Automated key rotation workflow (OIDC, CloudTrail audit, SSM) |
