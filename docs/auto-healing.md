# Auto-Healing & Health Monitoring

## Overview

Two CronJobs provide automated cluster self-healing and health reporting:

| CronJob | Namespace | Schedule | Purpose |
|---------|-----------|----------|---------|
| `auto-healer` | `cloudless` | every 3 min | Fixes ECR ImagePullBackOff; logs CrashLoopBackOff |
| `health-monitor` | `kube-system` | every 2 min | Checks Traefik readiness, VIP response, app health |

---

## auto-healer (`k8s/cloudless/auto-healer.yaml`)

### What it does

1. **ImagePullBackOff / ErrImagePull** — Scans all pods in `cloudless`. If any are stuck in image pull failure:
   - Creates a one-off job from `ecr-cred-refresher` to refresh the ECR token
   - Waits 15s for the token to propagate
   - Force-deletes all failing pods so they reschedule with the fresh credentials

2. **CrashLoopBackOff** (logging only) — Reports pods with >5 restarts to logs. No automatic action taken.

### RBAC

ServiceAccount `auto-healer` in `cloudless` with:
- `pods`: get, list, watch, delete
- `cronjobs` (batch): get, list, watch
- `jobs` (batch): create

### Failure modes covered

| Failure | Detection | Remediation |
|---------|-----------|-------------|
| ECR token expired (12h TTL) | `ImagePullBackOff` on any pod | Trigger `ecr-cred-refresher` + pod delete |
| Image not found / wrong tag | `ErrImagePull` on any pod | Same as above |
| App crash loop | `CrashLoopBackOff` + restarts >5 | Log warning (manual action required) |

---

## health-monitor (`k8s/health-monitor/health-monitor.yaml`)

### What it does

Every 2 minutes, checks three things in sequence:

1. **Traefik deployment** — `kubectl get deployment traefik -n kube-system`. If `readyReplicas < 1`, issues `kubectl rollout restart deployment/traefik`.

2. **Traefik VIP** — `curl https://192.168.1.200:18443/`. If no HTTP response (or `000`), marks Traefik FAIL.

3. **App health endpoint** — `curl https://cloudless.online/api/health`. Passes if response contains `ok`.

### Output format

Each run prints a summary line:

```
[2026-05-04T02:16:57Z] health: traefik=OK app=OK
```

### RBAC

ServiceAccount `health-monitor` in `kube-system` with:
- `deployments` (apps): get, list, update, patch
- `pods`: get, list

---

## Ops runbook

### Check auto-healer logs

```bash
kubectl logs -n cloudless -l job-name --selector='job-name' --tail=20
# Or for the most recent completed job:
kubectl get jobs -n cloudless --sort-by=.metadata.creationTimestamp | tail -3
kubectl logs -n cloudless job/<job-name>
```

### Check health-monitor logs

```bash
kubectl get jobs -n kube-system --sort-by=.metadata.creationTimestamp | tail -3
kubectl logs -n kube-system job/<job-name>
```

### Force a manual auto-healer run

```bash
kubectl create job ah-manual-$(date +%s) --from=cronjob/auto-healer -n cloudless
```

### Force a manual health check

```bash
kubectl create job hm-manual-$(date +%s) --from=cronjob/health-monitor -n kube-system
```

### If Traefik keeps restarting

The health-monitor will issue `rollout restart` but cannot fix the root cause. Check:

```bash
kubectl describe deployment traefik -n kube-system
kubectl logs -n kube-system deploy/traefik --previous
kubectl get helmchartconfig traefik -n kube-system -o yaml
```

Common causes: bad `HelmChartConfig` values (see [traefik helmchartconfig history](#)).

---

## Design decisions

- **No auto-restart for CrashLoopBackOff** — Restarting a crash-looping pod just delays the inevitable and can mask bugs. The monitor logs it for human action.
- **15s ECR wait** — ECR credential secrets need time to propagate to the kubelet image pull credential cache before rescheduled pods can use them.
- **`concurrencyPolicy: Forbid`** — Prevents overlapping runs if a job takes longer than the schedule interval (e.g. during a slow ECR token refresh).
- **`backoffLimit: 0`** — Failed runs are visible immediately in job history rather than being retried silently.
- **`ttlSecondsAfterFinished: 120`** — Completed jobs auto-delete after 2 minutes to keep namespace clean.

---

## Files

| Path | Description |
|------|-------------|
| `k8s/cloudless/auto-healer.yaml` | ServiceAccount, Role, RoleBinding, CronJob |
| `k8s/health-monitor/health-monitor.yaml` | ServiceAccount, Role, RoleBinding, CronJob |
