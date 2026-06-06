# Deploy-Pi CI/CD Pipeline

Automated build + rollout for `cloudless-pi-app` (serving `cloudless.gr`) via GitHub Actions.

## Architecture

```
push to main
     │
     ▼
┌─────────────────────────────────┐
│  build-and-push                 │
│  runs-on: ubuntu-24.04-arm      │  ← GitHub-hosted native arm64
│                                 │
│  1. OIDC → ECR login            │
│  2. Check if SHA tag exists     │
│  3. docker buildx build (arm64) │
│  4. Push :$SHA tag to ECR       │
│  5. Update SSM current-image-sha│
└──────────────┬──────────────────┘
               │ needs: build-and-push
               ▼
┌─────────────────────────────────┐
│  rollout                        │
│  runs-on: [self-hosted, omv]    │  ← runner on omv-main (Pi5)
│                                 │
│  kubectl set image ... :$SHA    │
│  kubectl rollout status ...     │
└─────────────────────────────────┘
```

## Self-hosted Runner

Installed on omv-main 2026-05-20. Handles only the rollout job — the Pi never runs Docker builds.

| Property | Value |
|----------|-------|
| Service | `actions.runner.Themis128-cloudless.gr.omv.service` |
| Install dir | `/home/tbaltzakis/actions-runner-cloudless-gr/` |
| Runner name / label | `omv` |
| Runner version | 2.334.0 |

**Why hybrid?** Docker builds on the Pi caused load spikes to 18 and k3s OOM crashes (2026-05-18). The build job moved to GitHub-hosted `ubuntu-24.04-arm` (native arm64, no QEMU, no Pi load). The rollout job stays self-hosted because it needs direct access to the local k3s API — no Tailscale tunnel or authkey rotation required.

## Design decisions

**ECR immutable tags** — only SHA-pinned tags (`:$GITHUB_SHA`) are pushed. `:latest` is never used. Prevents silent overwrites.

**OIDC auth** — no static AWS keys in the workflow. Role `AWS_DEPLOY_ROLE_ARN` is assumed via OIDC token on every run.

**Skip-build guard** — if the image SHA already exists in ECR (rerun of same commit), the build steps are skipped and the rollout proceeds directly.

**Concurrency group** — `concurrency: group: deploy-pi / cancel-in-progress: true` ensures only one deploy runs at a time; new pushes cancel the in-progress run.

## GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `AWS_DEPLOY_ROLE_ARN` | OIDC role for ECR push + SSM write |
| `NEXT_PUBLIC_SITE_URL` | Baked into Docker image at build time |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | Build arg |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | Build arg |
| `NEXT_PUBLIC_HUBSPOT_PORTAL_ID` | Build arg |
| `NEXT_PUBLIC_SENTRY_DSN` | Build arg |
| `NEXT_PUBLIC_META_PIXEL_ID` | Build arg |

> `TS_AUTHKEY`, `SSH_DEPLOY_KEY`, and `KUBECONFIG_B64` are no longer used and can be deleted.

## Verifying a deploy

```bash
# Image SHA in the running deployment
sudo k3s kubectl get deployment cloudless -n cloudless \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# Pod rollout status
sudo k3s kubectl rollout status deployment/cloudless -n cloudless

# App responding
curl -s -o /dev/null -w "%{http_code}" https://cloudless.gr/
# expects: 307 (HTTPS redirect)
```

## Runner maintenance

```bash
# Check runner health
systemctl status actions.runner.Themis128-cloudless.gr.omv.service

# Restart if needed
sudo systemctl restart actions.runner.Themis128-cloudless.gr.omv.service

# Update runner binary
cd /home/tbaltzakis/actions-runner-cloudless-gr
sudo ./svc.sh stop
./config.sh remove --token <pat>   # deregister
# download new tarball, extract, re-configure, re-install
sudo ./svc.sh install tbaltzakis
sudo ./svc.sh start
```

## History

| Date | Change |
|------|--------|
| 2026-05-11 | Pipeline introduced; both jobs on GitHub-hosted runners, k3s accessed via KUBECONFIG over public API |
| 2026-05-18 | Moved to Tailscale SSH approach after direct API exposure was removed; introduced `TS_AUTHKEY` and `SSH_DEPLOY_KEY` |
| 2026-05-20 | Installed self-hosted runner on omv-main; rollout job switched to `[self-hosted, omv]`; removed Tailscale/SSH entirely |
