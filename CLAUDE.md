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

## Available skills and commands

### Slash commands (instant lookup)
| Command | Purpose |
|---|---|
| `/health-check` | Full system: AWS + cluster + tunnel |
| `/etcd-status` | etcd latency, disk warnings, DB size |
| `/cluster-nodes` | Node resources, taints, pod distribution |
| `/cert-check` | cert-manager expiry and renewal status |
| `/cloudflare-status` | Tunnel connectors, DNS, LB pool health |
| `/cognito-users` | Search/list/inspect Cognito users |
| `/cognito-pool-status` | Pool config, app clients, Lambda triggers |
| `/sync-analytics-now` | Trigger immediate S3→DuckDB sync |
| `/deploy-maintenance` | Apply maintenance CronJobs to cluster |
| `/public-pages` | Audit cloudless.gr CMS databases (Blog, Cases, Services, FAQs, Testimonials) |

### Skills (autonomous agents — invoke via Skill tool)
| Skill | Purpose | Argument |
|---|---|---|
| `analytics-orchestrator` | Full analytics stack check+fix | `check\|fix\|full` |
| `runner-ops` | GitHub Actions runner fleet health+fix | `check\|fix\|legion` |
| `manifest-deploy` | Pre-flight validated kubectl apply | `<path> [--dry-run]` |
| `security-audit` | Repo + cluster credential scan | `repo\|cluster\|full` |
| `oncall-triage` | Alert investigation + fix playbook | `<alert-name> [--fix]` |
| `cognito-user-ops` | User lifecycle management | `<action> <email>` |
| `cognito-app-client` | Auth failure diagnosis + client mgmt | `diagnose\|update-callbacks\|…` |
| `cms-content` | Public CMS content audit + fix AI dashes + publish | `audit\|fix-dashes <db>\|publish <id>\|list <db>` |
| `cognito-migration` | Remove all Keycloak dead code from cloudless.gr + replace register/resend with Cognito | `dry-run\|apply` |
| `tailscale-oauth-setup` | Set up TS_OAUTH_CLIENT_ID, TS_OAUTH_SECRET, PI_SSH_KEY for CI→cluster access | *(no args)* |

## Cluster node topology (updated 2026-05-24 demotion)

| Node | Hardware | Role | LAN IP | Tailscale IP |
|---|---|---|---|---|
| `omv-main` | Pi 5 (Cortex-A76, 8 GB) | k3s **server** — control-plane + etcd | 192.168.1.128 | 100.113.41.119 |
| `omv-ha` | Pi 3B (Cortex-A53, 1 GB) | k3s **agent** only (demoted 2026-05-24) | 192.168.1.130 | — |

**omv-ha demotion (2026-05-24):** omv-ha is now a k3s agent only — no etcd, no control-plane taint. NFS workloads (ntfy, alertmanager) that were running there are unaffected. The old control-plane role moved to omv-main.

## omv-ha node (Pi 3B, 1 GB) — annual config checklist
See Notion task "omv-ha PR #13 — annual config review" (due 2027-06-03) for the full checklist.
Key invariants to maintain (post-demotion state):
- systemd memory ceiling must be applied: `MemoryHigh=750M` / `MemoryMax=900M` (script: `k8s/ha/scripts/apply-omv-ha-memory-ceiling.sh`)
- `disable: local-storage` must NOT appear in omv-ha k3s config (breaks local-path-provisioner)
- `cloudflared-ha` deployment must stay in `cloudless` namespace (second tunnel connector for HA)
- `journal-vacuum-omv-ha` CronJob must target omv-ha via `nodeSelector`

**omv-main** (k3s server, control-plane) key invariants:
- etcd tuning: heartbeat 300 ms, election 3000 ms — tuned for SD-card fsync latency
- Do not lower these values. `took too long` warnings <200 ms are expected and harmless.

## Automation workflows
| Workflow | File | Purpose |
|----------|------|---------|
| Keycloak removal | `.github/workflows/apply-keycloak-removal.yml` | Two-job: `cognito-setup` (AWS OIDC only, no Tailscale) + `cluster-apply` (needs `TS_OAUTH_*` secrets). Run with `apply_cluster=false` first if Tailscale isn't set up yet. |
| Cloudflare LB | `.github/workflows/provision-cloudflare-lb.yml` | Create active-passive LB via API — needs `CF_LB_API_TOKEN` secret |
| Tailscale OAuth | `.github/workflows/tailscale-connect.yml` | Reusable workflow for Tailscale in CI — needs `TS_OAUTH_CLIENT_ID` + `TS_OAUTH_SECRET` secrets |
| AWS key rotation | `.github/workflows/rotate-aws-key.yml` | Rotate IAM keys via OIDC — needs `grant-iam-all.sh` run first |
| Pi runner restart | `.github/workflows/restart-pi-runners.yml` | Restart/re-register self-hosted runners on omv-2/omv-3 |
| kubectl dispatch | `.github/workflows/kubectl-dispatch.yml` | Run any kubectl command on k3s via Tailscale SSH — needs `TS_OAUTH_*` + `PI_SSH_KEY` |
| CF token revoke | `.github/workflows/cloudflare-token-revoke.yml` | Self-revoke CLOUDFLARE_API_TOKEN via Cloudflare API (no dashboard needed) |

## Pending credential / provisioning steps

**One-time local setup — ✅ DONE (run from AWS CloudShell 2026-06-04):**
```bash
# All workflow IAM permissions granted:
bash k8s/ha/scripts/grant-iam-all.sh   # CloudShell-compatible (no --profile needed)
```

**apply-keycloak-removal.yml status:**
- ✅ Pass 1 COMPLETE — Cognito client `cloudless-oauth2-proxy` (ID: `63d3fu5lp057694h0t70je4jk0`) exists; secret stored in SSM `/cloudless/production/oauth2-proxy-client-secret`
- ⏸ Pass 2 DEFERRED — `cluster-apply` job needs Tailscale secrets; also `cloudless.online` domain is gone (2026-06-04), making oauth2-proxy deployment moot until domain/app is restored. Delete keycloak namespace manually when SSH access is available.

**Security items — deferred to end of infrastructure build-out:**
⚠️  Do NOT prioritise these until the infrastructure build-out is complete. Address as a batch once cluster and app are stable.
- Revoke exposed CF token `cfut_ulgWeq...` → use `cloudflare-token-revoke.yml` workflow (no dashboard needed)
- Create replacement CF token with `Zone:DNS:Edit` scope → `gh secret set CLOUDFLARE_API_TOKEN`
- Create CF LB API token (`Load Balancers:Edit` + `Monitors and Pools:Edit`) — hold until domain/app decided
- Rotate exposed IAM key `AKIAUBXIAELU5SADA3XL` (ses-smtp-prod) → use `rotate-aws-key.yml` workflow

**Tailscale OAuth (only needed when cluster SSH access via CI is required):**
- Create OAuth client at admin.tailscale.com → Settings → OAuth clients (`auth_keys` scope)
- `gh secret set TS_OAUTH_CLIENT_ID --body "tskey-client-..."` + `TS_OAUTH_SECRET`

**cluster-apply Pass 2 (deferred — needs Tailscale + active domain/app):**
```bash
gh workflow run apply-keycloak-removal.yml \
  -f skip_cognito_client=true \
  -f cognito_client_id=63d3fu5lp057694h0t70je4jk0 \
  -f apply_cluster=true
```

## Git history
- Exposed Cloudflare token scrubbed from all history via `git filter-repo` on 2026-06-03 (PR #13 branch)
- All subsequent pushes to this branch are force-pushed due to rewritten history

---

## Cluster operational rules

### Node assignment
| Workload type | Node | Reason |
|---|---|---|
| All primary user pods (deployments, statefulsets) | `omv-main` (Pi 5, 8 GB) | Main compute node |
| DaemonSets (node-exporter, flannel) | both nodes | DaemonSets schedule on all nodes |
| `journal-vacuum-omv-ha` CronJob | `omv-ha` + nodeSelector | Needs hostPID to vacuum that node's journal |
| Alertmanager, ntfy | `omv-ha` (NFS-backed) | NFS workloads unaffected by 2026-05-24 demotion |

Note: omv-ha has ~700 MB RAM — keep workload count low. NFS-backed pods (ntfy, alertmanager) can stay there; memory-heavy pods (Prometheus, Metabase, ML) must be on omv-main.

### ARM64 image requirement
Every container image deployed to this cluster **must** support `linux/arm64` (aarch64).
- Verify: `docker manifest inspect <image> | grep -i arm64` or check Docker Hub tags
- Images built in CI use `docker buildx` with `--platform linux/arm64`
- Never pin to a tag that ships amd64-only (e.g., many older `:latest` tags)

### Storage class selection
| Class | Access mode | When to use |
|---|---|---|
| `local-path` | ReadWriteOnce | Stateful workloads that always run on `omv-main` (Prometheus, Grafana, duckdb-data) |
| `nfs` | ReadWriteMany | Workloads that might move nodes or need shared access (Alertmanager, ntfy) |

Rule: if `nodeSelector: kubernetes.io/hostname: omv-main` is set, `local-path` is safe and faster.
If no node selector or the workload runs on omv-ha, use `nfs`.

### Secret hygiene
- **Never commit** credentials, tokens, API keys, passwords, or kubeconfigs to this repo
- Kubernetes secrets: create with `kubectl create secret` — never as YAML in repo
- Helm secrets: use `existingSecret` references (see grafana-admin-credentials pattern)
- AWS keys in k8s: inject via `envFrom.secretRef`, never in ConfigMaps or values files
- `.gitignore` covers: `*.pem`, `*.key`, `credentials.json`, `kubeconfig*`, `token*`, `.env*`
- If a credential is accidentally committed: run `git filter-repo --replace-text` immediately, force-push, rotate the credential

### Resource limits — ARM constraints
Every pod **must** have `resources.requests` and `resources.limits` set.
Pi 5 (omv-main) total allocatable: ~7.5 GB RAM, 4 cores.
Pi 3B (omv-ha) total allocatable after reservations: ~700 MB RAM, 4 cores.

Rough budget for omv-main:
- Monitoring stack: ~3 GB (Prometheus 2 GB + Grafana 768 MB + etc.)
- Analytics stack: ~2 GB (Metabase 1 GB + duckdb-api + ML jobs)
- Remaining: ~2.5 GB for n8n, oncall, cloudless, home-assistant

### Pre-deploy checklist (before `kubectl apply` or `helm upgrade`)
1. Secrets exist: `kubectl get secret <name> -n <namespace>`
2. PVCs provisioned (if needed): `kubectl get pvc -n <namespace>`
3. Node selector is `omv-main` for memory-heavy workloads; `omv-ha` only for NFS-backed lightweight pods
4. Image has arm64 variant
5. Resource limits set on all containers
6. `storageClassName` matches node selector (local-path only if pinned to omv-main)

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

### etcd tuning (PR #13, now applies to omv-main post-demotion)
Heartbeat: 300 ms, election: 3000 ms — tuned for SD-card fsync latency on omv-main.
Do not lower these values. `took too long` warnings <200 ms are expected and harmless.

---

## AWS Cognito — cloudless.gr user auth

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
5. **Hosted UI domain** — if configured, the domain name is the Cognito auth entry point for OAuth flows; keep it aligned with `cloudless.gr` branding
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
