# omv-ha cluster — Claude memory

## After any infrastructure change or hardening PR
Log a Notion task in the **Tasks** database (`Themis128/Cloudless` workspace) with:
- Type: Chore
- Labels: docs
- Due Date: ~1 year out
- Content: what was changed, what to verify annually, relevant PR link

Also **update the existing annual review task** "omv-ha PR #13 — annual config review"
(https://app.notion.com/p/3747d82c410a8163a5e3f84f9216a0f1) if the new change adds
an invariant that must be checked annually — append to its checklist rather than
creating a separate task for every small change.

## omv-ha node (Pi 4, 1 GB) — annual config checklist
See Notion task "omv-ha PR #13 — annual config review" (due 2027-06-03) for the full checklist.
Key invariants to maintain:
- `node-taint: control-plane:NoSchedule` must remain in `/etc/rancher/k3s/config.yaml`
- systemd memory ceiling must be applied: `MemoryHigh=750M` / `MemoryMax=900M` (script: `k8s/ha/scripts/apply-omv-ha-memory-ceiling.sh`)
- `kube-reserved=memory=300Mi` — do NOT reduce; etcd+apiserver+controllers need it
- `ntfy` and Alertmanager must run on `omv`, not omv-ha
- `journal-vacuum-omv-ha` CronJob must keep its `control-plane:NoSchedule` toleration
- `disable: local-storage` must NOT appear in omv-ha k3s config (breaks local-path-provisioner HA)
- `cloudflared-ha` deployment must stay in `cloudless` namespace (second tunnel connector for HA)

## Automation workflows (added PR #13, 2026-06-03)
| Workflow | File | Purpose |
|----------|------|---------|
| Cloudflare LB | `.github/workflows/provision-cloudflare-lb.yml` | Create active-passive LB via API — needs `CF_LB_API_TOKEN` secret |
| Tailscale OAuth | `.github/workflows/tailscale-connect.yml` | Reusable workflow for Tailscale in CI — needs `TS_OAUTH_CLIENT_ID` + `TS_OAUTH_SECRET` secrets |
| AWS key rotation | `.github/workflows/rotate-aws-key.yml` | Rotate IAM keys via OIDC — needs `grant-iam-key-rotation.sh` run first |
| Pi runner restart | `.github/workflows/restart-pi-runners.yml` | Restart/re-register self-hosted runners on omv-2/omv-3 |

## Pending manual credential steps (tracked in Notion task "omv-ha infra — complete 5 manual credential/provider steps")
1. Revoke exposed Cloudflare API token `cfut_ulgWeq...` in dashboard — create replacement with `Zone:DNS:Edit`
2. Rotate AWS IAM key `AKIAUBXIAELU5SADA3XL` — run `rotate-aws-key.yml` workflow (run `grant-iam-key-rotation.sh` first)
3. Create Cloudflare LB API token (`Load Balancers:Edit` + `Monitors and Pools:Edit`) → set `CF_LB_API_TOKEN` secret → run `provision-cloudflare-lb.yml`
4. Create Tailscale OAuth client (`auth_keys` scope) → `gh secret set TS_OAUTH_CLIENT_ID` + `TS_OAUTH_SECRET`
5. Run `AWS_PROFILE=admin bash k8s/ha/scripts/grant-iam-create-user.sh` (SES SMTP IAM policy)

## Git history
- Exposed Cloudflare token scrubbed from all history via `git filter-repo` on 2026-06-03 (PR #13 branch)
- All subsequent pushes to this branch are force-pushed due to rewritten history

---

## Cluster operational rules

### Node assignment
| Workload type | Node | Reason |
|---|---|---|
| All user pods (deployments, statefulsets) | `omv` (Pi 5, 8 GB) | omv-ha is tainted control-plane:NoSchedule |
| DaemonSets (node-exporter, flannel) | both nodes | DaemonSets tolerate control-plane taint |
| `journal-vacuum-omv-ha` CronJob | `omv-ha` + toleration | Needs hostPID to vacuum that node's journal |
| Alertmanager, ntfy | `omv` only | Moved off omv-ha in PR #13 |

Never schedule user workloads on omv-ha — it has only ~700 MB allocatable after etcd + apiserver + controllers.

### ARM64 image requirement
Every container image deployed to this cluster **must** support `linux/arm64` (aarch64).
- Verify: `docker manifest inspect <image> | grep -i arm64` or check Docker Hub tags
- Images built in CI use `docker buildx` with `--platform linux/arm64`
- Never pin to a tag that ships amd64-only (e.g., many older `:latest` tags)

### Storage class selection
| Class | Access mode | When to use |
|---|---|---|
| `local-path` | ReadWriteOnce | Stateful workloads that always run on `omv` (Prometheus, Grafana, duckdb-data) |
| `nfs` | ReadWriteMany | Workloads that might move nodes or need shared access (Alertmanager) |

Rule: if `nodeSelector: kubernetes.io/hostname: omv` is set, `local-path` is safe and faster.
If no node selector or the workload might live on omv-ha someday, use `nfs`.

### Secret hygiene
- **Never commit** credentials, tokens, API keys, passwords, or kubeconfigs to this repo
- Kubernetes secrets: create with `kubectl create secret` — never as YAML in repo
- Helm secrets: use `existingSecret` references (see grafana-admin-credentials pattern)
- AWS keys in k8s: inject via `envFrom.secretRef`, never in ConfigMaps or values files
- `.gitignore` covers: `*.pem`, `*.key`, `credentials.json`, `kubeconfig*`, `token*`, `.env*`
- If a credential is accidentally committed: run `git filter-repo --replace-text` immediately, force-push, rotate the credential

### Resource limits — ARM constraints
Every pod **must** have `resources.requests` and `resources.limits` set.
Pi 5 (omv) total allocatable: ~7.5 GB RAM, 4 cores.
Pi 4 (omv-ha) total allocatable after reservations: ~700 MB RAM, 4 cores.

Rough budget for omv:
- Monitoring stack: ~3 GB (Prometheus 2 GB + Grafana 768 MB + etc.)
- Analytics stack: ~2 GB (Metabase 1 GB + duckdb-api + ML jobs)
- Remaining: ~2.5 GB for n8n, oncall, ntfy, cloudless, home-assistant

### Pre-deploy checklist (before `kubectl apply` or `helm upgrade`)
1. Secrets exist: `kubectl get secret <name> -n <namespace>`
2. PVCs provisioned (if needed): `kubectl get pvc -n <namespace>`
3. Node selector is `omv` (not `omv-ha`) for any new workload
4. Image has arm64 variant
5. Resource limits set on all containers
6. `storageClassName` matches node selector (local-path only if pinned to omv)

### Deploy order (first-time cluster setup)
See README.md for the full ordered deploy sequence. Summary:
1. cert-manager, traefik, nfs-provisioner (external)
2. Create k8s secrets (`setup-monitoring-secrets.sh`, `kubectl create secret` for each)
3. Monitoring (`helm upgrade kube-prom`)
4. OnCall deps → OnCall engine
5. Analytics, n8n, ntfy, home-assistant
6. Maintenance CronJobs
7. PrometheusRules

### Alertmanager config — dual config block
`kube-prometheus-stack-values.yaml` has **two** `config:` blocks under `alertmanager:`.
The first (lines ~55–109) is the production routing config (ntfy + oncall-webhook + alert-api).
The second (lines ~154–187) is a legacy stub kept for Helm schema compatibility.
Only the first block is active. Do not merge or delete either — Helm expects both keys.

### etcd tuning (PR #13)
Heartbeat: 300 ms, election: 3000 ms — tuned for SD-card fsync latency on omv-ha.
Do not lower these values. `took too long` warnings <200 ms are expected and harmless.

---

## AWS Cognito — cloudless.online user auth

### Pool topology

| Resource | Value |
|---|---|
| Region | `us-east-1` |
| User Pool ID | stored as `NEXT_PUBLIC_COGNITO_USER_POOL_ID` in `Themis128/cloudless.gr` GitHub secrets |
| App Client ID | stored as `NEXT_PUBLIC_COGNITO_CLIENT_ID` in `Themis128/cloudless.gr` GitHub secrets |
| App client type | **Public** (no client secret) — Next.js SPA/SSR uses PKCE flow |
| Admin access | `AWS_PROFILE=admin` locally; `GitHubActionsOIDC` role in CI |

`NEXT_PUBLIC_*` values are baked into the browser bundle — they are not sensitive to expose, but
keeping them in GitHub secrets centralizes config management and allows rotation without re-committing.

### Cognito operational rules

1. **Never hardcode** User Pool ID, Client ID, or any Cognito admin credentials in manifests, scripts, or this repo
2. **Admin operations from CI** must use the `GitHubActionsOIDC` role (OIDC, no static keys). Add `cognito-idp:*` to the role policy only if needed — scope to the specific pool ARN.
3. **App client is public** — it has no client secret. Never add a client secret to the existing Next.js client. If a confidential client is needed (e.g., server-to-server), create a separate app client.
4. **User import / bulk ops** require an IAM role with `cognito-idp:AdminCreateUser` scoped to the pool ARN — not wildcard `cognito-idp:*`
5. **Hosted UI domain** — if configured, the domain name is the Cognito auth entry point for OAuth flows; keep it aligned with `cloudless.online` branding
6. **Password policy** — min 8 chars, require uppercase + number + symbol. Do not weaken it.
7. **MFA** — optional for users (TOTP or SMS). Do not force-disable MFA pool-wide.
8. **Token expiry defaults** (do not reduce): access 1h, ID 1h, refresh 30d. Shorter refresh forces frequent re-logins on the Pi-served app.

### Cognito ↔ cluster interaction

The Cognito User Pool is an AWS-side resource — the k3s cluster does not directly connect to it.
Interaction paths:
- `cloudless-app` (Next.js, `cloudless` namespace) — validates Cognito JWT tokens on incoming requests
- `cloudless.gr` CI — reads `NEXT_PUBLIC_COGNITO_*` build args from GitHub secrets and bakes them into the Docker image
- Admin operations — run from local machine with `AWS_PROFILE=admin` or via GitHub Actions

### Required IAM permissions for Cognito admin operations

These must be attached to whatever role/user performs pool management:
```json
{
  "Effect": "Allow",
  "Action": [
    "cognito-idp:ListUsers",
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminCreateUser",
    "cognito-idp:AdminSetUserPassword",
    "cognito-idp:AdminDisableUser",
    "cognito-idp:AdminEnableUser",
    "cognito-idp:AdminDeleteUser",
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:ListGroups",
    "cognito-idp:AdminListGroupsForUser"
  ],
  "Resource": "arn:aws:cognito-idp:us-east-1:278585680617:userpool/<POOL_ID>"
}
```
