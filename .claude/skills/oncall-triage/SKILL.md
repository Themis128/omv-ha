---
name: oncall-triage
description: >
  Alert triage agent. When an alert fires (Prometheus, Alertmanager, ntfy, or Grafana OnCall),
  investigate root cause across cluster, app, and infra layers, classify severity, suggest
  and optionally apply fixes. Run when you receive an alert or when something is broken.
argument-hint: "<alert-name-or-description> [--fix]"
allowed-tools: >
  mcp__cloudless-infra__cluster_run_command,
  mcp__cloudless-infra__cluster_health_check,
  mcp__cloudless-infra__k3s_get_cluster_status,
  mcp__cloudless-infra__k3s_get_pods,
  mcp__cloudless-infra__k3s_get_pod_logs,
  mcp__cloudless-infra__k3s_restart_deployment,
  mcp__cloudless-infra__cloudflare_tunnel_status,
  mcp__cloudless-infra__aws_get_infrastructure_summary,
  mcp__cloudless-infra__metabase_check_health,
  mcp__cloudless-infra__ml_pipeline_status,
  mcp__Kubernetes_MCP_Server__kubectl_get,
  mcp__Kubernetes_MCP_Server__kubectl_logs,
  mcp__Kubernetes_MCP_Server__kubectl_describe,
  mcp__Kubernetes_MCP_Server__kubectl_rollout,
  Bash,
  Read
---

# OnCall Triage Skill

Structured alert investigation agent. Identifies root cause, classifies impact, and applies safe
auto-fixes. Everything else is escalated with a clear action brief.

## Step 0 — Parse alert

From `$ARGUMENTS`, extract:
- Alert name (e.g., `KubePodCrashLooping`, `NodeMemoryPressure`, `TargetDown`)
- Affected resource (namespace, pod, node, service)
- `--fix` flag: if present, apply safe auto-fixes; otherwise report-only

If the alert is vague (user says "something is broken" or "the site is down"), default to
full health check path — run `health-check` command first, then narrow based on findings.

---

## Step 1 — Classify the alert category

| Alert pattern | Category | Investigation path |
|---|---|---|
| `KubePod*`, `KubeDeployment*` | Pod/workload | Step 2A |
| `NodeMemoryPressure`, `NodeDiskPressure`, `KubeNodeNotReady` | Node | Step 2B |
| `TargetDown`, `PrometheusJobMissing` | Scrape target | Step 2C |
| `AlertmanagerDown`, `PrometheusDown` | Monitoring self | Step 2D |
| `KubeEtcd*` | etcd | Run `/etcd-status` |
| Cloudflare / tunnel / DNS | Infra | Run `/cloudflare-status` |
| Analytics / Metabase / duckdb | App | Run `analytics-orchestrator` skill |
| Unknown | Full scan | Run `/health-check` |

---

## Step 2A — Pod/workload investigation

```bash
# Identify affected pods
kubectl get pods -n <namespace> -o wide
kubectl describe pod <pod-name> -n <namespace>
```

Collect from describe output:
- Exit code (137 = OOMKill, 1 = app error, 2 = misuse, 128+signal = crash)
- Last state `Terminated.reason`
- Events (ImagePullBackOff, Unschedulable, FailedMount, etc.)
- Resource limits vs usage

```bash
# Recent logs (last 100 lines, and previous container if crashed)
kubectl logs <pod-name> -n <namespace> --tail=100 2>/dev/null
kubectl logs <pod-name> -n <namespace> --previous --tail=50 2>/dev/null
```

**Exit code → root cause mapping:**

| Exit code | Cause | Auto-fix |
|---|---|---|
| 137 | OOMKill | Bump memory limit, then restart |
| 1 | App error | Check logs for specific error |
| ImagePullBackOff | Registry auth or wrong tag | Check imagePullSecret |
| Unschedulable | No node fits (taint/resource) | Check nodeSelector + omv-ha taint |
| FailedMount | PVC not found or wrong SC | Check PVC status |
| CrashLoopBackOff (exit 0) | App exits immediately | Check command/entrypoint |

**Safe auto-fixes (apply if `--fix` flag set):**
- OOMKill on analytics/n8n/oncall: `kubectl rollout restart deployment/<name> -n <namespace>` (buys time)
- CrashLoop with recent code push: `kubectl rollout undo deployment/<name> -n <namespace>`
- ImagePullBackOff (arm64 missing): alert user immediately — do NOT restart loop
- Unschedulable on omv-ha: add/verify nodeSelector → `kubectl patch deployment ...`

---

## Step 2B — Node investigation

```bash
kubectl describe node <node-name>
kubectl top node <node-name> 2>/dev/null
```

**omv (Pi 5) memory pressure:**
```bash
ssh tbaltzakis@192.168.1.128 "free -m; df -h; systemctl status k3s --no-pager -l | tail -5"
```

Identify memory hog:
```bash
kubectl top pods -A --sort-by=memory | head -20
```

**omv-ha (Pi 3B) memory pressure — critical:**
```bash
ssh tbaltzakis@192.168.1.130 "free -m; systemctl show k3s --property=MemoryHigh,MemoryMax,MemoryCurrent"
```

omv-ha has only ~700 MB allocatable. If at 90%+ after reservations:
1. Check for user pods that shouldn't be there (missing taint)
2. Check etcd compaction
3. Verify systemd ceiling: `MemoryHigh=750M / MemoryMax=900M`

**Safe auto-fixes:**
- User pod on omv-ha: fix nodeSelector, delete pod to reschedule
- Disk pressure: `kubectl exec -n kube-system $(kubectl get pod -n kube-system -l app=svclb-traefik -o name | head -1) -- df -h` to find disk hog

---

## Step 2C — Scrape target down

```bash
# Check Prometheus targets
kubectl port-forward -n monitoring svc/monitoring-prometheus 9090:9090 &
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | select(.health != "up") | {job: .labels.job, instance: .labels.instance, error: .lastError}'
```

Or check via Grafana at `https://grafana.cloudless.gr`.

If a ServiceMonitor target is down:
1. Verify the service/pod is Running
2. Verify port name matches the ServiceMonitor `port:` field
3. Verify namespace is included (Prometheus scrapes ALL namespaces)

---

## Step 2D — Monitoring self-health

If Alertmanager is down:
```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=alertmanager -o wide
```
Expected: on `omv` (not omv-ha). If on omv-ha and pending → taint issue from PR #13 changes.

If Prometheus is down:
```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus -o wide
kubectl describe pod -n monitoring -l app.kubernetes.io/name=prometheus | grep -A10 "Events:"
```

Common: OOMKill on retention scrape. Check storage:
```bash
kubectl exec -n monitoring <prometheus-pod> -- df -h /prometheus
```
If >80% → increase `retentionSize` in `kube-prometheus-stack-values.yaml` or reduce `retention`.

---

## Step 3 — Impact classification

After investigation, classify:

**CRITICAL** (page immediately):
- cloudless.gr returning 5xx / not reachable
- Cloudflare tunnel down (zero connectors)
- Prometheus down for >15 min (blind monitoring)
- Both cluster nodes NotReady
- etcd quorum lost

**WARNING** (address within 1 hour):
- Single pod CrashLoopBackOff in production namespace
- omv-ha memory >85% of ceiling
- Alertmanager down (alerts queued, not lost)
- Analytics pipeline stale >2h

**INFO** (address same day):
- ML job failed once
- Single scrape target down
- cert expiry in <30 days

---

## Step 4 — Report format

```
ALERT TRIAGE: <alert-name>
Severity: CRITICAL / WARNING / INFO
Affected: <resource> in <namespace> on <node>

Root cause:
  [One sentence identifying the cause]

Evidence:
  - Pod events: [key events from describe]
  - Logs: [key log lines]
  - Resource usage: [CPU/memory at time of alert]

Impact:
  [What is broken, what is not affected]

Auto-fixes applied (if --fix):
  - [action] → [result]

Required manual action:
  - [specific command or step]
  - Urgency: [immediate / within 1h / same day]

Related alerts to check:
  - [alert names that may be symptoms of the same root cause]
```

---

## Known alert suppressions (from alertmanager config)

These alerts are intentionally disabled — do not investigate unless user explicitly asks:
- `KubeSchedulerDown` — k3s embeds scheduler, not scraped separately
- `KubeControllerManagerDown` — k3s embeds controller manager
- `KubeProxyDown` — k3s uses kube-router
- `NodeRAIDDegraded` / `NodeRAIDDiskFailure` — NVMe/SD hardware, no RAID
- `NodeFileDescriptorLimit` — constant false positive on Pi 3B 1GB under normal load
- `KubeAPIErrorBudgetBurn` — production SLO, too noisy for homelab
- `Watchdog` — intentional no-op heartbeat
- `InfoInhibitor` — meta alert for info inhibition pattern
