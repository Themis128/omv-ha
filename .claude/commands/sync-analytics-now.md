---
description: Trigger an immediate S3→DuckDB sync job without waiting for the 30-min schedule
---

Trigger an on-demand S3 sync to refresh analytics data immediately.

Run via `mcp__cloudless-infra__cluster_run_command` on omv-main:

```bash
kubectl create job -n analytics \
  --from=cronjob/s3-to-duckdb-sync \
  "sync-manual-$(date -u +%Y%m%d-%H%M%S)"
```

Then tail the logs to confirm success:

```bash
# Get the job pod name
kubectl get pods -n analytics -l job-name --sort-by=.metadata.creationTimestamp --no-headers | tail -1

# Stream logs (replace POD_NAME)
kubectl logs -n analytics POD_NAME --follow
```

Expected output:
```
[2026-...] Starting S3 sync from s3://cloudless-analytics-data/parquet/ ...
[2026-...] Sync complete.
```

If the job fails, check:
1. `kubectl describe pod -n analytics POD_NAME` — look for PVC mount errors or image pull issues
2. `kubectl get secret -n analytics duckdb-api-secrets` — verify secret exists
3. AWS credentials: `kubectl get secret -n analytics duckdb-api-secrets -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d`
