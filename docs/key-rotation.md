# Crypto-Agility & Key Rotation Runbook

## Overview

Crypto-agility means the system can rotate keys and swap algorithms without downtime. This document covers rotation procedures for all cryptographic material in the cloudless stack.

| Material | Location | TTL / Rotation trigger |
|----------|----------|------------------------|
| k3s secret encryption key (AES-GCM) | `/var/lib/rancher/k3s/server/crypt/` | Manual / on compromise |
| PostgreSQL TLS cert | cert-manager `postgres-tls` secret | 365d auto (cert-manager) |
| Cloudless internal CA | cert-manager `cloudless-internal-ca` | 10yr, manual rotation |
| ECR pull secret (`regcred-ecr`) | `cloudless` namespace | 12h TTL, auto-refreshed every 6h |
| Sync-webhook HMAC secret (`SYNC_HMAC_SECRET`) | `cloudless-app-config` secret | Manual / on compromise |
| Cloudflare API token | `cert-manager` secret | Manual / per policy |

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

## 2. PostgreSQL TLS Certificate

cert-manager auto-renews `postgres-tls` 30 days before expiry (`renewBefore: 720h`). The certificate is valid for 365 days (`duration: 8760h`).

### Check cert expiry

```bash
kubectl get certificate postgres-tls -n keycloak
# Ready=True, status shows NotAfter date

# Or inspect the actual cert:
kubectl get secret postgres-tls -n keycloak -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -dates
```

### Force early renewal

```bash
kubectl delete secret postgres-tls -n keycloak
# cert-manager detects the missing secret and immediately issues a new cert
# Watch progress:
kubectl describe certificate postgres-tls -n keycloak
```

### Apply new cert to running PostgreSQL

The PostgreSQL pod reads TLS certs on startup only (initContainer copies them). After cert renewal, restart the pod:

```bash
kubectl rollout restart deployment/postgres -n keycloak
```

---

## 3. Cloudless Internal CA

The self-signed CA (`cloudless-internal-ca`) is valid for 10 years. If it needs to be rotated (compromise or expiry):

```bash
# 1. Delete the CA secret — cert-manager will regenerate it via the ClusterIssuer
kubectl delete secret cloudless-internal-ca -n keycloak

# 2. This invalidates all certs signed by the old CA. Force-renew postgres-tls:
kubectl delete secret postgres-tls -n keycloak

# 3. Restart PostgreSQL so it picks up the new cert
kubectl rollout restart deployment/postgres -n keycloak

# 4. Restart Keycloak — its DB connection uses the new cert chain
kubectl rollout restart deployment/keycloak -n keycloak
```

---

## 4. Sync-Webhook HMAC Secret

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

## 5. ECR Pull Secret

Auto-rotated every 6 hours by `ecr-cred-refresher` CronJob. Manual rotation:

```bash
kubectl create job ecr-refresh-now --from=cronjob/ecr-cred-refresher -n cloudless
kubectl get secret regcred-ecr -n cloudless  # AGE should reset to <1m
```

---

## 6. Cloudflare API Token (cert-manager)

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

## 7. AWS IAM Access Key

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

## Rotation Schedule (recommended)

| Material | Frequency |
|----------|-----------|
| k3s encryption key | Annually or on any node compromise |
| PostgreSQL cert | Automatic (cert-manager, 365d) |
| HMAC secret | Every 90 days or on any webhook exposure |
| Cloudflare token | Every 90 days or on any CI/CD credential leak |
| ECR pull secret | Automatic (every 6h) |
| AWS IAM access key | Every 90 days or immediately on exposure |
| Internal CA | Every 10 years or on compromise |

---

## Files

| Path | Description |
|------|-------------|
| `k8s/keycloak/postgres-tls.yaml` | cert-manager Certificate + Issuer for PostgreSQL TLS |
| `k8s/cloudless/ecr-cred-refresher.yaml` | ECR credential auto-rotation CronJob |
| `k8s/cloudless/auto-healer.yaml` | Detects ECR pull failures and triggers refresh |
| `k8s/ha/scripts/grant-iam-key-rotation.sh` | Grants OIDC role permissions for key rotation |
| `.github/workflows/rotate-aws-key.yml` | Automated key rotation workflow (OIDC, CloudTrail audit, SSM) |
