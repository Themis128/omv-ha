# OMV-HA — Cloudless k3s Cluster

Two-node embedded-etcd k3s cluster running on Raspberry Pi hardware, serving [cloudless.gr](https://cloudless.gr) and acting as the secondary path for [cloudless.gr](https://cloudless.gr).

## Nodes

| Hostname | Hardware | Role | IP |
|----------|----------|------|----|
| `omv` | Pi 5 (8 GB) | server + worker | 192.168.1.128 |
| `omv-ha` | Pi 4 (1 GB) | server + worker | 192.168.1.130 |
| VIP | keepalived VRRP | kube-apiserver endpoint | 192.168.1.200 |

WireGuard CNI (flannel-native). etcd heartbeat 300 ms / election 3000 ms (tuned for SD-card fsync latency).

## Repository layout

```
k8s/
├── analytics/          # DuckDB API + Metabase + S3 sync CronJob (namespace: analytics)
├── ha/
│   └── config/         # k3s server configs for both nodes
├── maintenance/        # Cluster maintenance CronJobs — GC, journal vacuum, health check (namespace: maintenance)
├── monitoring/         # kube-prometheus-stack Helm values + PrometheusRules
├── n8n/                # n8n workflow engine (namespace: n8n)
└── oncall/             # Grafana OnCall deps, Helm values, ingress, security
```

> Namespaces not tracked as manifests (managed externally or by Helm): `cert-manager`, `kube-system`, `traefik`, `cloudless`, `oncall` (Helm-managed engine), `nfs-provisioner`.

## Namespaces

| Namespace | Contents | Node affinity |
|-----------|----------|---------------|
| `analytics` | duckdb-api, metabase, s3-to-duckdb-sync CronJob | omv |
| `cloudless` | cloudless-manager, cloudless-app (standby), oauth2-proxy, cloudflared-ha | omv / omv-ha |
| `home-assistant` | home-assistant | omv |
| `maintenance` | CronJobs (RS GC, journal vacuum, health check) | mixed |
| `monitoring` | Prometheus, Grafana, Alertmanager, kube-state-metrics, node-exporter | omv / omv-ha |
| `n8n` | n8n workflow engine | omv |
| `ntfy` | ntfy push notification server | omv |
| `oncall` | oncall-engine, oncall-celery, oncall-mariadb, oncall-redis | omv |

## Secrets reference

All secrets are created manually (`kubectl create secret`) and are **not** stored in this repo. Placeholders marked `REPLACE_WITH_*` must be filled before applying.

| Secret name | Namespace | Keys |
|-------------|-----------|------|
| `duckdb-api-secrets` | analytics | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ANALYTICS_S3_BUCKET` |
| `n8n-secrets` | n8n | `N8N_ENCRYPTION_KEY`, `NOTION_API_KEY`, `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL` |
| `oncall-mariadb-secret` | oncall | `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` |
| `oncall-basicauth` | oncall | `users` (htpasswd format) |
| `aws-creds` | monitoring | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (Grafana CloudWatch) |
| `grafana-admin-credentials` | monitoring | `admin-user`, `admin-password` (Grafana admin login) |
| `cloudflared-credentials` | cloudless | `credentials.json` (tunnel credential JSON from omv-main) |

> Note: no actual credential values are committed in this repo. Create secrets manually with `kubectl create secret` or other secret management tooling, and keep values out of source control.
>
> For k3s etcd S3 snapshots, use `k8s/ha/scripts/enable-s3-snapshots.sh` or runtime secret injection instead of embedding AWS keys in config files.

## GitHub Actions secrets and variables

Set with `gh secret set NAME` (secrets) or `gh variable set NAME --body VALUE` (variables).

| Name | Type | Used by | How to obtain |
|------|------|---------|---------------|
| `PI_SSH_KEY` | Secret | `restart-pi-runners.yml` | Private key with SSH access to omv-2/omv-3 |
| `RUNNER_REGISTRATION_PAT` | Secret | `restart-pi-runners.yml` | GitHub PAT → repo scope |
| `CF_LB_API_TOKEN` | Secret | `provision-cloudflare-lb.yml` | Cloudflare dashboard → API Tokens → scopes: `Load Balancers:Edit`, `Load Balancing Monitors and Pools:Edit` |
| `TS_OAUTH_CLIENT_ID` | Secret | `tailscale-connect.yml` | Tailscale admin → Settings → OAuth Clients → scope: `auth_keys` |
| `TS_OAUTH_SECRET` | Secret | `tailscale-connect.yml` | Same OAuth client creation as above |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | `provision-cloudflare-lb.yml` | `fb7dc7b69b662480cd5961a4d1913c78` |
| `CLOUDFLARE_ZONE_ID` | Variable | `provision-cloudflare-lb.yml` | cloudless.gr zone ID — find at dash.cloudflare.com → cloudless.gr → Overview (right sidebar) |

## Deploy order (fresh cluster)

```bash
# 1. Core infra (cert-manager, traefik, nfs-provisioner) — managed externally

# 2. Monitoring
helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  -f k8s/monitoring/kube-prometheus-stack-values.yaml

# 3. OnCall deps (MariaDB + Redis)
kubectl apply -f k8s/oncall/oncall-deps.yaml

# 4. OnCall engine (Helm)
helm upgrade --install oncall grafana/oncall -n oncall --create-namespace \
  -f k8s/oncall/values.yaml

# 5. OnCall ingress + security middlewares
kubectl apply -f k8s/oncall/oncall-security.yaml
# Create oncall-basicauth secret with real htpasswd hash first, then:
kubectl apply -f k8s/oncall/oncall-ingress.yaml

# 6. Analytics
kubectl apply -f k8s/analytics/duckdb-api.yaml
kubectl apply -f k8s/analytics/metabase.yaml
kubectl apply -f k8s/analytics/sync-cronjob.yaml   # S3→PVC sync (analytics ns — shares duckdb-data PVC)

# 7. n8n
kubectl apply -f k8s/n8n/n8n.yaml

# 8. Maintenance CronJobs (RS GC, journal vacuum, health check — no AWS creds needed)
kubectl apply -f k8s/maintenance/cronjobs.yaml

# 9. PrometheusRules
kubectl apply -f k8s/monitoring/analytics-prometheusrules.yaml
```

## Cloudflare Tunnel

All `*.cloudless.gr` traffic enters via a Cloudflare tunnel (`cloudflared` on omv-main, tunnel ID `a82f24a8`). There is no public IPv4 inbound — only the tunnel and IPv6.

## cloudless.gr failover

`cloudless.gr` uses Route 53 failover routing:
- **PRIMARY**: CloudFront → SST/OpenNext Lambda (managed in `Themis128/cloudless.gr`)
- **SECONDARY**: API Gateway → `cloudless-pi-proxy` Lambda → Pi over IPv6

## etcd recovery

If both nodes lose quorum simultaneously (e.g. power cut):

```bash
# On the node with the most recent etcd data:
sudo systemctl stop k3s
sudo k3s server --cluster-reset
sudo systemctl start k3s
# Then rejoin the second node normally
```
