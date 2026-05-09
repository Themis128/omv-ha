---
description: Apply maintenance CronJobs and analytics S3 sync CronJob to the cluster
---

Deploy the maintenance stack to the cluster. Run these steps in order:

1. **Apply maintenance CronJobs** (RS GC, journal vacuum, cluster health check):
   ```
   Use mcp__cloudless-infra__cluster_run_command on omv-main:
   kubectl apply -f /path/to/k8s/maintenance/cronjobs.yaml
   ```
   Since the repo is not cloned on the Pi, use kubectl apply from stdin or copy the manifest first.
   
   Actually: use `mcp__cloudless-infra__k3s_describe_resource` or `kubectl_apply` if available,
   otherwise run: `kubectl apply -f https://raw.githubusercontent.com/...` or pipe via SSH.

   The correct approach for this project is to SCP the file to the Pi then apply:
   ```bash
   # On Windows, use the deploy workflow:
   scp k8s/maintenance/cronjobs.yaml tbaltzakis@192.168.1.128:/tmp/
   ssh tbaltzakis@192.168.1.128 "kubectl apply -f /tmp/cronjobs.yaml"
   ```

2. **Apply analytics S3 sync CronJob** (must be in analytics namespace to access duckdb-data PVC):
   ```bash
   scp k8s/analytics/sync-cronjob.yaml tbaltzakis@192.168.1.128:/tmp/
   ssh tbaltzakis@192.168.1.128 "kubectl apply -f /tmp/sync-cronjob.yaml"
   ```

3. **Verify**:
   Use `mcp__cloudless-infra__cluster_run_command` on omv-main:
   ```
   kubectl get cronjobs -n maintenance
   kubectl get cronjobs -n analytics
   ```
   
   Expected: s3-to-duckdb-sync in analytics ns, replicaset-gc + journal-vacuum-* + cluster-health-check in maintenance ns.

4. **Trigger a test sync** (optional):
   ```
   kubectl create job -n analytics --from=cronjob/s3-to-duckdb-sync sync-test-$(date +%s)
   kubectl logs -n analytics -l job-name=sync-test-... --follow
   ```
