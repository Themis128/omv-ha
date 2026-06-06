---
description: Show node resource usage, taints, conditions, and pod distribution across omv and omv-ha
---

Snapshot the current state of both cluster nodes — capacity, usage, taints, and what's running where.

Use `mcp__cloudless-infra__cluster_run_command` on omv-main for each step:

## 1. Node status and conditions

```bash
kubectl get nodes -o wide
kubectl describe nodes | grep -A10 "Conditions:" | grep -E "Ready|MemoryPressure|DiskPressure|PIDPressure"
```

## 2. Node taints

```bash
kubectl get nodes -o custom-columns="NODE:.metadata.name,TAINTS:.spec.taints[*].key"
```

Expected:
- `omv` → no taints (general-purpose worker)
- `omv-ha` → no taints (agent-only since 2026-05-24; control-plane taint removed at demotion)

## 3. Resource allocation

```bash
kubectl top nodes 2>/dev/null || echo "metrics-server not installed"
kubectl describe node omv | grep -A15 "Allocated resources"
kubectl describe node omv-ha | grep -A15 "Allocated resources"
```

## 4. Pod distribution — what's running where

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=omv \
  --no-headers | awk '{print $1, $2, $4}' | column -t | sort
```

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=omv-ha \
  --no-headers | awk '{print $1, $2, $4}' | column -t | sort
```

**Expected on omv-ha** (only system + DaemonSets):
- `kube-system`: flannel/wireguard DaemonSet pod, kube-proxy (if applicable), metrics-server
- `monitoring`: node-exporter DaemonSet pod
- Nothing else — user workloads here means the taint is missing or pods have incorrect tolerations

**Expected on omv** (all user workloads):
- `analytics`: metabase, duckdb-api, ML jobs, s3-sync
- `monitoring`: prometheus, grafana, alertmanager, kube-state-metrics
- `n8n`: n8n
- `ntfy`: ntfy
- `oncall`: oncall-engine, oncall-celery, oncall-mariadb, oncall-redis
- `cloudless`: cloudless-manager, cloudless-app, oauth2-proxy, cloudflared, cloudflared-ha
- `home-assistant`: home-assistant

## 5. Memory pressure check (omv-ha 1 GB limit)

```bash
# On omv-ha — check systemd memory ceiling
ssh tbaltzakis@192.168.1.130 "systemctl show k3s --property=MemoryHigh,MemoryMax"
```

Expected: `MemoryHigh=786432000` (750M), `MemoryMax=943718400` (900M).
If these are missing → run `k8s/ha/scripts/apply-omv-ha-memory-ceiling.sh`.

## Report format

```
NODES: HEALTHY / DEGRADED

omv (Pi 5, 8 GB)      ✅  Ready — CPU: X%  RAM: XGB/7.5GB  Disk: X%
omv-ha (Pi 3B, 1 GB)  ✅  Ready — CPU: X%  RAM: XMB/900MB  Disk: X%

Taints:
  omv      — none (general worker) ✅
  omv-ha   — none (agent only, demoted 2026-05-24) ✅

Pod distribution:
  omv:    N pods across N namespaces
  omv-ha: N pods (DaemonSets only ✅ / user pods present ❌)

Issues:
  - [node]: [symptom] → [recommended action]
```
