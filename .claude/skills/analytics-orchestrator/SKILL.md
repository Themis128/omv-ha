---
name: analytics-orchestrator
description: >
  Orchestrator agent for the analytics stack (Metabase + duckdb-api + DuckDB + ML pipeline + S3 sync).
  Checks every component, diagnoses root causes, and auto-fixes where safe.
  Run after any incident, deploy, or when the user says something is broken in analytics.
argument-hint: "[check | fix | full]"
allowed-tools: >
  mcp__cloudless-infra__metabase_check_health,
  mcp__cloudless-infra__metabase_get_logs,
  mcp__cloudless-infra__metabase_h2_query,
  mcp__cloudless-infra__metabase_duckdb_lock_fix,
  mcp__cloudless-infra__metabase_reset_password,
  mcp__cloudless-infra__ml_duckdb_unlock,
  mcp__cloudless-infra__ml_pipeline_status,
  mcp__cloudless-infra__ml_trigger_job,
  mcp__cloudless-infra__ml_get_logs,
  mcp__cloudless-infra__ml_run_history,
  mcp__cloudless-infra__ml_get_scores,
  mcp__cloudless-infra__ml_check_models,
  mcp__cloudless-infra__ml_anomaly_latest,
  mcp__cloudless-infra__ml_feature_summary,
  mcp__cloudless-infra__k3s_get_pods,
  mcp__cloudless-infra__k3s_get_pod_logs,
  mcp__cloudless-infra__k3s_restart_deployment,
  mcp__cloudless-infra__cluster_run_command,
  mcp__cloudless-infra__cluster_health_check,
  mcp__Kubernetes_MCP_Server__kubectl_get,
  mcp__Kubernetes_MCP_Server__kubectl_logs,
  mcp__Kubernetes_MCP_Server__kubectl_describe,
  mcp__Kubernetes_MCP_Server__kubectl_scale,
  mcp__Kubernetes_MCP_Server__kubectl_rollout
---

# Analytics Stack Orchestrator

Autonomous check-and-fix agent for the full analytics pipeline. Runs top-to-bottom,
fixes what it can, and clearly reports what needs human intervention.

## Architecture overview

```
S3 (cloudless-analytics-data)
  └─ s3-to-duckdb-sync CronJob (every 30 min)
       └─ writes Parquet → /data PVC (duckdb-data, 10Gi, local-path on omv)

duckdb-api (analytics ns, omv)          Metabase (analytics ns, omv)
  image: duckdb-api-local:v2              image: metabase-debian:v0.55
  in-memory DuckDB                        H2 DB on metabase-data PVC
  reads Parquet from /data PVC            DuckDB JDBC → analytics.duckdb (read-only)
  /execute ← ML pipeline writes scores    URL: https://metrics.cloudless.online
  /query   ← n8n + cloudless.online

ML CronJobs (analytics ns, omv)
  ml-feature-engineer (Sun 01:00 UTC)
  ml-train-rfm / churn / collab / anomaly
  ml-detect-anomaly (every 15 min)
  ml-content-decay (Mon 02:00 UTC)
```

**Critical concurrency rule**: `analytics.duckdb` file is owned exclusively by Metabase
(read-only JDBC). duckdb-api uses in-memory DuckDB — it NEVER opens the file.
ML jobs write via duckdb-api `/execute`. The only writer of `analytics.duckdb` is
the H2 migration engine inside Metabase on first boot.

---

## Step 0 — Argument routing

- `$ARGUMENTS` is empty or `check` → run Steps 1–5 (read-only audit), report, stop
- `$ARGUMENTS` is `fix` → run Steps 1–5 then apply all safe auto-fixes from Step 6
- `$ARGUMENTS` is `full` → run Steps 1–7 including ML pipeline verification
- No argument → default to `fix` (check + fix)

---

## Step 1 — Pod status (parallel)

Run `k3s_get_pods(namespace="analytics")` and `metabase_check_health(verify_login=False)` simultaneously.

**Expected pods:**

| Pod prefix | Status | Notes |
|-----------|--------|-------|
| `metabase-*` | `1/1 Running` | init container `install-duckdb-driver` must have completed |
| `duckdb-api-*` | `1/1 Running` | |
| `s3-to-duckdb-sync-*` | `0/1 Completed` | CronJob pods; multiple OK, all `Completed` is healthy |
| `ml-*` | `0/1 Completed` | ML job pods; `Running` is fine if job active |

**Flag conditions:**
- Any pod in `CrashLoopBackOff`, `OOMKilled` (exit 137), `Error`, `ImagePullBackOff`, `Pending` → ISSUE
- `metabase-*` stuck in `Init:0/1` for >5 min → ISSUE (init container wget likely failing)
- `duckdb-api-*` restart count > 2 in last hour → ISSUE
- `metabase-*` restart count > 0 with `READY=0/1` → ISSUE

---

## Step 2 — Metabase health

Call `metabase_check_health(verify_login=True)`.

Check:
1. Pod `READY` → `1/1`
2. `/api/health` → `{"status":"ok"}`
3. Login → returns session `id` (not 401)

If login returns 401 → password has changed since setup. Note for Step 6 fix.

Then query H2 to verify DuckDB connection sync status (uses `metabase_h2_query`):
```sql
SELECT id, name, engine, initial_sync_status FROM metabase_database ORDER BY id;
```
Expected: `Analytics DuckDB | duckdb | complete`. If `incomplete` or `aborted` → ISSUE.

> ⚠️ `metabase_h2_query` scales Metabase to 0 then back to 1 — only call this if
> Metabase is NOT already down, and only when `check` mode is explicitly requested
> OR when diagnosing a DuckDB sync failure.

---

## Step 3 — duckdb-api health

Run via `cluster_run_command`:
```bash
DAPI=http://$(kubectl get pod -n analytics -l app=duckdb-api -o jsonpath='{.items[0].status.podIP}'):8000
curl -sf $DAPI/health
curl -sf $DAPI/tables
```

Expected:
- `/health` → `{"status":"ok","db":"duckdb"}`
- `/tables` → list includes `web_analytics`, `ml_runs`, `ml_features`, `scores_churn`,
  `scores_rfm`, `scores_recs`, `features_*`, `ab_*`

If `/tables` returns fewer than 5 tables → S3 sync may be stale or Parquet registration failed.

Run a smoke query:
```bash
curl -sf -X POST $DAPI/query -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT COUNT(*) as n FROM ml_runs LIMIT 1"}'
```
Expected: `count >= 1`. Zero rows → ML pipeline hasn't run yet (not an error on fresh deploy).

---

## Step 4 — S3 sync CronJob

```bash
kubectl get cronjob s3-to-duckdb-sync -n analytics
kubectl get jobs -n analytics -l app=s3-to-duckdb-sync --sort-by=.metadata.creationTimestamp
```

Check:
- Last completed job age < 35 min (runs every 30 min)
- No job in `Failed` state
- If last job is >35 min old and no active job → CronJob suspended or failing

Get logs of most recent completed job:
```bash
kubectl logs -n analytics \
  $(kubectl get pods -n analytics -l app=s3-to-duckdb-sync \
    --sort-by=.metadata.creationTimestamp -o name | tail -1)
```
Look for: `Sync complete`, `rows written`, `Parquet saved`. Error if: `NoCredentialsError`,
`AccessDenied`, `Connection refused to duckdb-api`.

---

## Step 5 — ML pipeline status (if `full` argument)

Call `ml_pipeline_status()` → summarise:
- Which CronJobs are active vs suspended
- Most recent job per CronJob — Succeeded / Failed / Running
- Any job stuck Running > 30 min → likely OOMKill pending

Call `ml_check_models()` → verify champion models exist for: rfm, churn, collab, anomaly.
Missing model → that training job has never succeeded.

Call `ml_anomaly_latest()` → check most recent anomaly window. If `is_anomaly=True` → flag
but do NOT auto-fix (anomalies are informational).

---

## Step 6 — Auto-fix playbook

Execute fixes in order. After each fix, re-check the affected component before proceeding.

### 6A. Metabase pod CrashLoopBackOff or OOMKilled

```bash
kubectl rollout restart deployment/metabase -n analytics
```
Then wait 5 min and re-check. If it OOMKills again → memory limit hit during Liquibase migration.
Temporary fix:
```bash
kubectl patch deployment metabase -n analytics \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"metabase","resources":{"limits":{"memory":"2048Mi"}}}]}}}}'
```
Update `metabase.yaml` memory limit accordingly.

### 6B. duckdb-api CrashLoopBackOff

Check logs first with `k3s_get_pod_logs(namespace="analytics", selector="app=duckdb-api")`.

Common causes and fixes:

| Log pattern | Root cause | Fix |
|-------------|-----------|-----|
| `Could not set lock on file` | DuckDB file lock conflict | Call `ml_duckdb_unlock()` then `k3s_restart_deployment("duckdb-api", "analytics")` |
| `No module named 'duckdb'` | Wrong image pulled | `kubectl rollout restart deployment/duckdb-api -n analytics` |
| `ImagePullBackOff` | GHCR auth expired | Check image is `duckdb-api-local:v2` with `imagePullPolicy: Never` |
| `duckdb.IOException` on startup | PVC not mounted | Check PVC `duckdb-data` is Bound |

### 6C. DuckDB file lock (Metabase can't sync)

Use `metabase_duckdb_lock_fix()` — this tool handles the full lock-release sequence.
If that fails, call `ml_duckdb_unlock()` as secondary fix.

### 6D. Metabase DuckDB database `initial_sync_status = incomplete` or `aborted`

```bash
# Trigger re-sync via Metabase API (need valid session)
curl -X POST http://<metabase-ip>:3000/api/database/33/sync_schema \
  -H "X-Metabase-Session: $SESSION"
```
If session not available → `metabase_reset_password()` to restore known credentials.

### 6E. Metabase login 401 (password changed)

The standard admin credentials for this cluster are documented in `metabase_reset_password` tool.
Call `metabase_reset_password()` with the correct bcrypt hash — it scales down, patches H2,
scales back up. Metabase will take ~5 min to come back ready.

### 6F. S3 sync failing (NoCredentialsError / AccessDenied)

```bash
kubectl get secret duckdb-api-secrets -n analytics \
  -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d
```
If key is `REPLACE_WITH_omv-main-cli-key` → secret was never populated.
Fix: `kubectl edit secret duckdb-api-secrets -n analytics` and set real values from
AWS console (key: `AKIAUBXIAELUYMUPWXLG`, secret in SSM parameter store).

### 6G. S3 sync failing (connection refused to duckdb-api)

duckdb-api is down. Fix 6B first, then trigger manual sync:
```bash
kubectl create job s3-sync-manual --from=cronjob/s3-to-duckdb-sync -n analytics
```

### 6H. ML job stuck in ImagePullBackOff

```bash
kubectl get deployment -n analytics -l app=duckdb-api \
  -o jsonpath='{.items[0].spec.template.spec.containers[0].image}'
```
ML image: `ghcr.io/themis128/ml-pipeline:latest`. If pull failing:
```bash
# Pre-pull on node
kubectl get pod -n analytics -l app=ml-pipeline -o wide  # find node
# Then on omv-main:
docker pull ghcr.io/themis128/ml-pipeline:latest
docker save ghcr.io/themis128/ml-pipeline:latest | k3s ctr images import -
```

### 6I. Metabase init container stuck (wget failing)

The init container downloads the DuckDB driver JAR from GitHub. If it times out:
```bash
kubectl describe pod <metabase-pod> -n analytics | grep -A5 "install-duckdb-driver"
```
If DNS/network issue → restart pod. If GitHub rate-limited → wait and retry.

---

## Step 7 — Post-fix verification

After all fixes are applied, run the full check again:
1. All analytics pods `1/1 Running` or `Completed`
2. `duckdb-api /health` → `ok`
3. `duckdb-api /tables` → ≥ 5 tables
4. Metabase `/api/health` → `ok`
5. Metabase login → succeeds
6. DuckDB DB `initial_sync_status = complete`

---

## Report format

```
ANALYTICS STACK: HEALTHY / DEGRADED / CRITICAL

Components:
  Metabase       ✅/❌  [READY=1/1 | not ready — reason]
  duckdb-api     ✅/❌  [READY=1/1 | crash — reason]
  S3 sync        ✅/❌  [last run Xmin ago | failed — reason]
  ML pipeline    ✅/⚠️  [all jobs OK | X failed | not checked]

Issues detected:
  - [component]: [symptom] → [fix applied / needs manual action]

Tables in duckdb-api: N (list if < 8)
Metabase DuckDB sync: complete / incomplete / aborted
Last anomaly detection: [timestamp] — anomaly: yes/no

Actions taken:
  - [fix description] → [result]

Remaining manual actions (if any):
  - [description] — [reason cannot auto-fix]
```

Flag CRITICAL if: Metabase pod down + duckdb-api down simultaneously, or PVC lost.
Flag DEGRADED if: one component down, sync stale, or DuckDB sync incomplete.
Flag HEALTHY if: all pods Running/Ready, sync recent, DuckDB sync complete.

---

## Known non-issues (do not flag)

- `oncall-celery` Exit Code 0 every ~65 min → intentional (CELERY_WORKER_SHUTDOWN_INTERVAL)
- `s3-to-duckdb-sync-*` pods in `Completed` → expected, CronJob pods always exit after run
- `metabase-*` READY=0/1 within first 4 min of startup → readiness probe has 240s delay
- `web_analytics` table has only 30 rows → small synthetic/test dataset, not an error
- duckdb-api `/tables` showing VIEW type for score tables → they are views over Parquet, correct
- ML jobs producing synthetic data → expected until real cloudless.online events feed in
