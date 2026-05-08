# OMV-HA — k3s Home Lab Infrastructure

Two-node HA k3s cluster on Raspberry Pi running cloudless.online and Home Assistant, with Cloudflare Tunnel for external access and ECR for private image hosting.

---

## Architecture

```
Internet
  │
  ├─ cloudless.online / *.cloudless.online
  │    └─ Cloudflare Tunnel (cloudflared on omv-main)
  │         └─ Traefik VIP 192.168.1.200:18443
  │
  └─ ha.cloudless.online
       └─ Cloudflare Tunnel → Traefik VIP → home-assistant:8123
```

### Nodes

| Node | IP | Role | Hardware |
|------|----|------|----------|
| omv | 192.168.1.128 | control-plane + etcd | Raspberry Pi 5 (8GB) |
| omv-ha | 192.168.1.130 | control-plane + etcd | Raspberry Pi 4 (1GB) |

- **VIP**: `192.168.1.200` managed by keepalived
- **k3s**: v1.35.4+k3s1
- **Traefik**: ports `18080` (HTTP) / `18443` (HTTPS)
- **SSH aliases**: `omv-main` → 192.168.1.128, `omv-ha` → 192.168.1.130

### HA Notes

2-node embedded etcd — losing one node drops API server (no quorum). Recovery procedure documented below. etcd snapshots pushed to S3 every 6h as backup.

---

## Workloads

### analytics namespace
| Resource | Detail |
|----------|--------|
| Deployment | `metabase` — 1 replica on omv, image `metabase/metabase:v0.53.x` |
| Deployment | `duckdb-api` — 1 replica on omv, local image `duckdb-api-local:v2` |
| URL | `https://metrics.cloudless.online` (Metabase) |
| PVC | `metabase-data` 2Gi, `duckdb-data` 10Gi — local-path on omv |
| Secret | `duckdb-api-secrets` — AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ANALYTICS_S3_BUCKET |

### cloudless namespace
| Resource | Detail |
|----------|--------|
| Deployment | `cloudless` — 1 replica on omv, image ECR `cloudless-pi-app:latest` |
| Deployment | `cloudless-manager` — 1 replica, local image |
| Deployment | `oauth2-proxy` — SSO proxy in front of cloudless-manager |
| Deployment | `cloudflared` — Cloudflare Tunnel daemon |
| Ingress | `cloudless.online`, `www.cloudless.online` → port 3000 |
| Ingress | `manage.cloudless.online` → oauth2-proxy → cloudless-manager |
| TLS | `cloudless-online-tls` (Let's Encrypt via cert-manager DNS-01) |
| Pull secret | `regcred-ecr` — refreshed every 6h by `ecr-cred-refresher` CronJob |

### home-assistant namespace
| Resource | Detail |
|----------|--------|
| Deployment | `home-assistant` — 1 replica, `Recreate` strategy, pinned to omv |
| Image | `ghcr.io/home-assistant/home-assistant:stable` |
| PVC | `home-assistant-config` — 5Gi, local-path |
| Ingress | `ha.cloudless.online` → port 8123 |
| TLS | `ha-cloudless-online-tls` (Let's Encrypt via cert-manager DNS-01) |

### keycloak namespace
| Resource | Detail |
|----------|--------|
| Deployment | `keycloak` — 1 replica, pinned to omv, image `quay.io/keycloak/keycloak:26.2` |
| Deployment | `postgres` — PostgreSQL 16-alpine, pinned to omv |
| PVC | `postgres-pvc` — 5Gi, local-path on omv |
| Ingress | `auth.cloudless.online` → port 8080 |
| TLS | `auth-cloudless-online-tls` (Let's Encrypt), `postgres-tls` (internal CA `cloudless-ca`) |

### monitoring namespace
| Resource | Detail |
|----------|--------|
| Helm | `kube-prometheus-stack` — Prometheus, Grafana (NodePort 10000), Alertmanager |
| Grafana | `https://grafana.cloudless.online` |
| Alertmanager | NFS PVC on omv-ha, routes: warnings → oncall-webhook, criticals → oncall-webhook + ntfy |
| Values | `k8s/monitoring/kube-prometheus-stack-values.yaml` |

### n8n namespace
| Resource | Detail |
|----------|--------|
| Deployment | `n8n` — 1 replica on omv, image `n8nio/n8n:1.44.1` |
| URL | `https://n8n.cloudless.online` |
| PVC | `n8n-data` — 2Gi, local-path (SQLite backend) |
| Secret | `n8n-secrets` — N8N_ENCRYPTION_KEY, ANTHROPIC_API_KEY, NOTION_API_TOKEN, SLACK_WEBHOOK_URL |

### ntfy namespace
| Resource | Detail |
|----------|--------|
| Deployment | `ntfy` — pinned to omv-ha (NFS PVC — NFS loopback broken on Pi5 kernel 6.12) |
| URL | `https://ntfy.cloudless.online` |
| PVC | `ntfy-data` — NFS, RWX |

### oncall namespace
| Resource | Detail |
|----------|--------|
| Helm | `grafana/oncall` chart — engine + celery + mariadb + redis |
| URL | `https://oncall.cloudless.online` |
| Engine/Celery | pinned to omv (Pi5 8GB), limits: engine 800Mi, celery 600Mi |
| DB | `oncall-mariadb-0` StatefulSet, MariaDB 11, 2Gi PVC |
| TLS | `oncall-cloudless-online-tls` (Let's Encrypt) |
| Plugin | `grafana-oncall-app@1.16.5` in Grafana, ORG_ID hardcoded to 100 |

### cert-manager namespace
- v1.20.2 via Helm (jetstack)
- ClusterIssuer: `letsencrypt-cloudflare` — DNS-01 challenge via Cloudflare API
- ClusterIssuer: `cloudless-ca` — self-signed internal CA for postgres TLS
- Secret: `cloudflare-api-token` in `cert-manager` namespace

### Cluster-wide
| Resource | Detail |
|----------|--------|
| `nfs-provisioner` | StorageClass `nfs` (RWX), backed by omv NFS `/srv/.../k3s-nfs` (92GB) — pods on omv CANNOT mount (Pi5 kernel 6.12 loopback bug), omv-ha can |
| `health-monitor` | CronJob monitoring cluster health |
| Traefik | HSTS middleware, compress middleware, HelmChartConfig for port overrides |

---

## ECR Credentials

ECR tokens expire every 12h. The `ecr-cred-refresher` CronJob runs every 6h and recreates `regcred-ecr` in the `cloudless` namespace.

**IAM user**: `omv-main-cli` — Key ID: `AKIAUBXIAELUYMUPWXLG`
**Policies**: `ecr-pull-readonly`, `etcd-snapshot-s3`
**Stored in**: k8s secret `pi-standby-aws-creds` (cloudless ns) and `~/.aws/credentials` on omv-main

```bash
kubectl create job ecr-refresh-now --from=cronjob/ecr-cred-refresher -n cloudless
kubectl logs job/ecr-refresh-now -n cloudless
```

---

## etcd Snapshots (S3)

Snapshots pushed to `s3://cloudless-etcd-snapshots/etcd/` every 6h. Retention: 3 local, 30 days on S3.

```bash
# Trigger manual snapshot
sudo k3s etcd-snapshot save --name "manual-$(date +%Y%m%d-%H%M%S)" \
  --data-dir /srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s

# List snapshots (local + S3)
sudo k3s etcd-snapshot ls --data-dir /srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s
```

---

## Cloudflare Tunnel

- **Tunnel ID**: `a82f24a8-...`
- **Runs on**: `omv-main` as a k3s deployment in `cloudless` namespace
- **Covers**: `cloudless.online`, `*.cloudless.online`
- **Ingress target**: `https://192.168.1.200:18443` (Traefik VIP)

---

## Cloudless Manager — Web GUI

Self-hosted management dashboard at **https://manage.cloudless.online** (SSO via oauth2-proxy → Keycloak).

```powershell
cd D:\cloudless-manager
.\deploy.ps1           # SCP + build + k3s import + rollout (~45s)
.\deploy.ps1 -SkipSync # restart only
```

Secret `cloudless-manager-secrets` in `cloudless` namespace:
`CF_TOKEN`, `CF_ZONE_ID`, `CF_ACCOUNT_ID`, `CF_TUNNEL_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`

---

## MCP Server (`cloudless-infra`)

TypeScript ESM server at `cloudless-infra-mcp-server/`.

```bash
cd cloudless-infra-mcp-server && pnpm build
```

| Prefix | Purpose |
|--------|---------|
| `k3s_*` | kubectl operations (pods, logs, restart, describe) |
| `cluster_*` | SSH commands, node health |
| `helm_*` | Helm deploy/status/uninstall |
| `cloudflare_*` | DNS records, tunnel status, cert check |
| `aws_*` | CloudWatch logs, Route53 health checks, SSM params |
| `failover_*` | Pi standby sync and failover checks |

---

## k8s Manifest Layout

```
k8s/
├── analytics/
│   ├── metabase.yaml
│   ├── duckdb-api.yaml
│   ├── duckdb-api/           # app.py, Dockerfile, requirements.txt
│   └── build-push-duckdb-api.ps1
├── cert-manager/
│   ├── clusterissuer-cloudflare.yaml
│   └── clusterissuer-selfsigned.yaml
├── cloudless/
│   ├── deployment.yaml       # Namespace, Deployment, Service, Certificate, Ingress
│   ├── ecr-cred-refresher.yaml
│   ├── auto-healer.yaml
│   └── oauth2-proxy.yaml
├── ha/
│   └── scripts/
│       ├── enable-s3-snapshots.sh
│       └── verify-quorum.sh
├── health-monitor/
│   └── health-monitor.yaml
├── home-assistant/
│   └── home-assistant.yaml
├── keycloak/
│   ├── keycloak.yaml
│   ├── postgres.yaml
│   └── postgres-tls.yaml
├── monitoring/
│   └── kube-prometheus-stack-values.yaml
├── n8n/
│   ├── n8n.yaml
│   ├── deploy-n8n.ps1
│   └── workflows/
│       └── analytics-to-notion.json
├── ntfy/
│   └── ntfy.yaml
├── oncall/
│   ├── values.yaml           # Helm values (grafana/oncall chart)
│   ├── ingress.yaml          # Certificate + Ingress (main + webhooks)
│   └── deps.yaml             # MariaDB + Redis secrets
├── traefik/
│   ├── compress-middleware.yaml
│   ├── helmchartconfig.yaml
│   └── hsts-middleware.yaml
└── nfs-provisioner.yaml
```

---

## Secrets Reference

| Secret | Namespace | Contents |
|--------|-----------|---------|
| `regcred-ecr` | cloudless | ECR dockerconfigjson (auto-refreshed every 6h) |
| `pi-standby-aws-creds` | cloudless | AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION |
| `cloudless-manager-secrets` | cloudless | CF_TOKEN, CF_ZONE_ID, CF_ACCOUNT_ID, CF_TUNNEL_ID, AWS creds |
| `cloudflare-api-token` | cert-manager | CLOUDFLARE_API_TOKEN for DNS-01 challenges |
| `cloudless-online-tls` | cloudless | TLS cert for cloudless.online + www |
| `ha-cloudless-online-tls` | home-assistant | TLS cert for ha.cloudless.online |
| `auth-cloudless-online-tls` | keycloak | TLS cert for auth.cloudless.online |
| `postgres-tls` | keycloak | Internal TLS cert issued by cloudless-ca |
| `keycloak-admin-secret` | keycloak | admin-user, admin-password |
| `keycloak-db-secret` | keycloak | username, password |
| `oncall-mariadb-secret` | oncall | MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD |
| `oncall-redis-external` | oncall | redis-password |
| `n8n-secrets` | n8n | N8N_ENCRYPTION_KEY, ANTHROPIC_API_KEY, NOTION_API_TOKEN, SLACK_WEBHOOK_URL |
| `duckdb-api-secrets` | analytics | AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ANALYTICS_S3_BUCKET |
| `oncall-cloudless-online-tls` | oncall | TLS cert for oncall.cloudless.online |

---

## Keycloak Access

```bash
kubectl get secret keycloak-admin-secret -n keycloak -o jsonpath='{.data.admin-password}' | base64 -d
```
Admin console: `https://auth.cloudless.online/admin`

---

## Grafana OnCall — Connection

The plugin UI "Connect" button uses the wrong endpoint for OSS. Must call manually:

```javascript
const r1 = await fetch('/api/plugins/grafana-oncall-app/resources/plugin/self-hosted/install', {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({})
});
const install = await r1.json();
// { error: null, stackId: 5, orgId: 100, onCallToken: "...", license: "OpenSource" }

await fetch('/api/plugins/grafana-oncall-app/settings', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    enabled: true,
    jsonData: { onCallApiUrl: 'http://oncall-engine.oncall.svc.cluster.local:8080', stackId: 5, orgId: 100 },
    secureJsonData: { onCallApiToken: install.onCallToken }
  })
});
```

---

## Runbooks

### Restart a deployment
```bash
kubectl rollout restart deployment/<name> -n <namespace>
kubectl rollout status deployment/<name> -n <namespace>
```

### Force ECR token refresh
```bash
kubectl create job ecr-refresh-now --from=cronjob/ecr-cred-refresher -n cloudless
```

### Check cluster health
```bash
kubectl get nodes -o wide
kubectl get pods -A
kubectl get certificates -A
```

### Redeploy Cloudless Manager
```powershell
cd D:\cloudless-manager
.\deploy.ps1        # full rebuild + rollout
.\deploy.ps1 -SkipSync  # restart pod only
```

### etcd Deadlock Recovery (2-node quorum loss)
1. Stop k3s on **both** nodes simultaneously
2. On omv-main: `sudo k3s server --cluster-reset --data-dir /srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s 2>&1 | tail -5`
3. On omv-main: `sudo systemctl start k3s` — wait until `kubectl get nodes` returns Ready
4. On omv-ha: `sudo rm -rf /var/lib/rancher/k3s/server/db/etcd`
5. On omv-ha: `sudo systemctl start k3s`
6. Verify: `kubectl get nodes` — both Ready with `control-plane,etcd` roles

**Critical**: stop omv-ha BEFORE starting omv-main after reset. If omv-ha's old k3s runs even briefly while omv-main resets, it adds a stale peer and breaks quorum again.

---

## Test Results — 2026-05-08

| Test | Result |
|------|--------|
| `omv` node | Ready ✅ |
| `omv-ha` node | Ready ✅ |
| All pods (34 Running + 3 Completed) | Running ✅ |
| `cloudless.online/api/health` | `{"status":"ok","version":"0.1.0"}` ✅ |
| `ha.cloudless.online` | HTTP 302 (login redirect) ✅ |
| `auth.cloudless.online` | HTTP 302 (Keycloak login) ✅ |
| `metrics.cloudless.online` | HTTP 200 (Metabase) ✅ |
| `n8n.cloudless.online` | HTTP 200 ✅ |
| `cloudless-online-tls` | READY ✅ |
| `ha-cloudless-online-tls` | READY ✅ |
| `auth-cloudless-online-tls` | READY ✅ |
| `grafana-cloudless-online-tls` | READY ✅ |
| `oncall-cloudless-online-tls` | READY ✅ |
| `n8n-tls` | READY ✅ |
| `ntfy-cloudless-online-tls` | READY ✅ |
| `metrics-tls` | READY ✅ |
| `postgres-tls` (internal CA) | READY ✅ |
| etcd S3 snapshots (`cloudless-etcd-snapshots`) | Active, every 6h ✅ |
| n8n secrets | Fully populated ✅ |
| alertmanager oncall webhook | Real token configured ✅ |

---

### Rebuild after node failure
1. Verify keepalived VIP is on surviving node
2. Check Cloudflare Tunnel: `kubectl get pods -n cloudless -l app=cloudflared`
3. Confirm ingress: `curl -sk -H 'Host: cloudless.online' https://192.168.1.200:18443/api/health`
