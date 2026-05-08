# Cloudless Sync Pipeline

## Overview

GitHub Actions → Tailscale Funnel → sync-webhook → image-sync Job → `kubectl rollout restart`

Keeps the k3s Pi standby image in sync with ECR automatically on every push to `main`.

---

## Components

### 1. GitHub Actions workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `deploy.yml` | push to main | SST deploy to AWS Lambda + CloudFront |
| `build-pi-image.yml` | push to main / workflow_dispatch | Build arm64 Docker image, push to ECR, write digest to SSM, trigger sync-webhook |
| `ha-sync-orchestrator.yml` | after deploy.yml completes | Ensures Pi build stays in lockstep with SST deploy SHA |

**IAM role:** `arn:aws:iam::278585680617:role/cloudless-github-actions` (OIDC, trust: `Themis128/cloudless.gr`)

**Permissions required:**
- `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:*` on `cloudless-pi-app`
- `ssm:PutParameter` on `arn:aws:ssm:us-east-1:278585680617:parameter/cloudless/production/ECR_LATEST_DIGEST`
  - Managed in `sst.config.ts` as `GithubActionsSSMDigestWrite` inline policy (applied on `sst deploy`)

### 2. SSM parameter

`/cloudless/production/ECR_LATEST_DIGEST` — stores the latest image digest pushed to ECR.  
Written by `build-pi-image.yml` after each successful build.  
Read by the `image-sync` CronJob to compare with the running pod.

### 3. Tailscale Funnel + socat proxy

External HTTPS requests to `omv.tail8eb71.ts.net` arrive via IPv6 from Tailscale.

```
Tailscale Funnel (IPv6 :443) → socat [::]:18443 → 192.168.1.200:18443 (Traefik VIP)
```

socat service: `/etc/systemd/system/traefik-ipv6-proxy.service`  
`ExecStart=/usr/bin/socat TCP6-LISTEN:18443,fork,reuseaddr,ipv6only=1 TCP4:192.168.1.200:18443`

### 4. Traefik Ingress (k3s)

```yaml
# namespace: cloudless
# Host: omv.tail8eb71.ts.net
# Routes: /_sync/ → sync-webhook:8080, /healthz → sync-webhook:8080
# Entrypoint: websecure (port 18443), TLS: true
```

### 5. sync-webhook (k3s Deployment)

Python HTTP server listening on `:8080`.  
Validates `X-Hub-Signature-256` HMAC-SHA256 against `SYNC_HMAC_SECRET` (from `cloudless-app-config` secret).  
Timestamp window: 300s (replay protection).  
On valid `POST /_sync/image`: creates a one-off Job cloned from the `image-sync` CronJob.

**Endpoints:**
- `GET /healthz` → `{"ok": true}`
- `POST /_sync/image` → triggers image-sync job immediately
- `POST /_sync/config` → triggers config-sync job immediately

### 6. image-sync CronJob (every minute)

Reads `ECR_LATEST_DIGEST` from SSM.  
Compares with the currently running pod's image digest.  
If different: `kubectl rollout restart deployment/cloudless-app`.  
If same: no-op.

### 7. config-sync CronJob (every 5 minutes)

Reads all 72 SSM parameters under `/cloudless/production/`.  
Compares hash with current `cloudless-app-config` secret.  
If different: updates the secret and restarts the deployment.

### 8. ecr-cred-refresher CronJob (every 6 hours)

ECR tokens expire after 12h. Runs every 6h for a 6h safety margin.  
Deletes and recreates `regcred-ecr` (dockerconfigjson) with a fresh token via `aws ecr get-login-password`.

---

## Normal flow (push to main)

```
1. push to main
   ├─ deploy.yml        → sst deploy → Lambda/CloudFront updated
   └─ build-pi-image.yml
       ├─ build arm64 Docker image
       ├─ push to ECR (SHA + :latest tags)
       ├─ write digest → SSM /cloudless/production/ECR_LATEST_DIGEST
       └─ POST /_sync/image (HMAC-signed) → sync-webhook
           └─ image-sync job created → compares digest → rollout restart if changed
2. ha-sync-orchestrator.yml
   └─ (if deploy.yml succeeded but no Pi build for that SHA)
       └─ dispatch build-pi-image.yml with target_sha
```

**Worst-case latency:** 60s (image-sync CronJob interval) if webhook is unreachable.

---

## Security

| Layer | Mechanism |
|-------|-----------|
| Webhook auth | HMAC-SHA256 (`X-Hub-Signature-256`), 300s replay window |
| Transit (webhook) | Tailscale Funnel TLS + Traefik TLS termination |
| Transit (DB) | PostgreSQL SSL (`ssl=on`), cert-manager CA chain |
| Secrets at rest | k3s AES-GCM encryption (`secrets-encryption: true`) |
| Image pull | ECR dockerconfigjson refreshed every 6h |
| Response compression | Traefik gzip middleware on all routes |

---

## Ops runbook

### ECR pull fails (ImagePullBackOff)

```bash
# Manually refresh ECR credentials
kubectl create job ecr-refresh-manual --from=cronjob/ecr-cred-refresher -n cloudless
# Delete the failing pod to force reschedule
kubectl delete pod <pod-name> -n cloudless
```

### Force immediate image sync

```bash
# From omv-main — sign and POST to webhook
S=$(kubectl get secret cloudless-app-config -n cloudless -o jsonpath='{.data.SYNC_HMAC_SECRET}' | base64 -d)
TS=$(date +%s)
B="{\"job\":\"image-sync\",\"ts\":${TS},\"sha\":\"manual\"}"
SIG="sha256=$(printf '%s' "$B" | openssl dgst -sha256 -hmac "$S" | awk '{print $2}')"
curl -fsS -X POST https://192.168.1.200:18443/_sync/image -k \
  -H "Host: omv.tail8eb71.ts.net" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" -d "$B"
```

### Check sync status

```bash
kubectl get pods,cronjobs -n cloudless
kubectl logs -n cloudless deploy/sync-webhook --tail=30
kubectl get secret -n cloudless regcred-ecr  # check AGE < 12h
```

### Apply IAM policy (sst.config.ts → GithubActionsSSMDigestWrite)

```bash
cd cloudless.gr
sst deploy --stage production
```

---

## Files

| Path | Description |
|------|-------------|
| `k8s/cloudless/ecr-cred-refresher.yaml` | ECR credential refresher CronJob (every 6h) |
| `cloudless.gr/.github/workflows/build-pi-image.yml` | arm64 build + SSM write + webhook trigger |
| `cloudless.gr/.github/workflows/ha-sync-orchestrator.yml` | Ensures Pi build locks to deploy SHA |
| `cloudless.gr/sst.config.ts` | `GithubActionsSSMDigestWrite` inline IAM policy |
| `/etc/systemd/system/traefik-ipv6-proxy.service` | socat IPv6→VIP proxy on omv-main |
