# omv-ha cluster — Claude memory

## After any infrastructure change or hardening PR
Log a Notion task in the **Tasks** database (`Themis128/Cloudless` workspace) with:
- Type: Chore
- Labels: docs
- Due Date: ~1 year out
- Content: what was changed, what to verify annually, relevant PR link

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
