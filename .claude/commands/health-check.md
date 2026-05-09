---
description: Full system health check — AWS serverless + k3s cluster + Cloudflare tunnel
---

Run a comprehensive health check of the full cloudless infrastructure. Check these in parallel:

1. **AWS / serverless path**
   - Use `mcp__cloudless-infra__aws_check_health_checks` (both primary and secondary)
   - Use `mcp__cloudless-infra__aws_get_infrastructure_summary` for context

2. **k3s cluster**
   - Use `mcp__cloudless-infra__k3s_get_cluster_status` — nodes, pods, services
   - Use `mcp__cloudless-infra__cluster_health_check` (both nodes) — disk, RAM, load

3. **Cloudflare tunnel**
   - Use `mcp__cloudless-infra__cloudflare_tunnel_status` (tail=20)

4. **Services**
   - Use `mcp__cloudless-infra__cluster_check_services` (both nodes, show_failed=true)

After collecting results, produce a structured report with these sections:
- ✅/⚠️/🔴 **AWS** — health check status, both paths
- ✅/⚠️/🔴 **Cluster nodes** — Ready status, memory, disk, load
- ✅/⚠️/🔴 **Pods** — any non-Running/non-Completed pods, high restart counts (>5)
- ✅/⚠️/🔴 **Tunnel** — active/errors
- ✅/⚠️/🔴 **Failed systemd units** — on either node

Flag as 🔴 critical: node NotReady, pod CrashLoopBackOff, tunnel down, health check UNHEALTHY.
Flag as ⚠️ warning: high restarts, memory <200Mi free, disk >80%, slow etcd (look at k3s service logs).
End with a one-line summary: "System healthy" or list the issues.
