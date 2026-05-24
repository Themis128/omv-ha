---
description: Check etcd health, latency, and slow-disk warnings on the cluster
---

Diagnose etcd performance on the k3s cluster.

> **Architecture (2026-05-24)**: etcd runs on **omv-main only** (single-member cluster). omv-ha was demoted to agent-only — it no longer participates in etcd. No quorum concerns; single member is always leader.
>
> **Non-default data-dir**: `/srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s/` (NVMe-backed external disk on omv-main).

Use `mcp__cloudless-infra__cluster_run_command` on omv-main for each step:

1. **Recent slow-disk warnings** (last 5 minutes of k3s logs):
   ```bash
   journalctl -u k3s --since "5 minutes ago" --no-pager \
     | grep -E "took too long|linearizableReadLoop|election" | tail -20
   ```

2. **etcd endpoint health**:
   ```bash
   kubectl -n kube-system exec -it $(kubectl get pod -n kube-system -l component=etcd -o name | head -1) \
     -- etcdctl endpoint health --endpoints=https://127.0.0.1:2379 \
     --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
     --cert=/var/lib/rancher/k3s/server/tls/etcd/server-client.crt \
     --key=/var/lib/rancher/k3s/server/tls/etcd/server-client.key 2>&1 || true
   ```
   
   Simpler alternative:
   ```bash
   kubectl get --raw /healthz/etcd 2>&1
   ```

3. **etcd DB size**:
   ```bash
   DATA_DIR=/srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s
   ls -lh ${DATA_DIR}/server/db/etcd/member/snap/db 2>/dev/null || \
   du -sh ${DATA_DIR}/server/db/etcd/ 2>&1 | head -5
   ```

4. **Current etcd args** (verify tuning is applied):
   ```bash
   grep -A5 "etcd-arg" /etc/rancher/k3s/config.yaml
   ```
   Expected: heartbeat-interval=300, election-timeout=3000, quota-backend-bytes=2147483648

Interpret results:
- `took too long` warnings with <200ms are **expected** on SD card — tuning prevents election flips, not raw I/O latency
- Warnings >500ms or frequent leader changes → investigate disk health with `iostat -xz 1 5`
- DB size >1.5GB → consider etcd compaction
