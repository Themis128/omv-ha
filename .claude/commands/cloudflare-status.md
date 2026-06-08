---
description: Check Cloudflare tunnel connectors, DNS resolution, and Load Balancer health for cloudless.gr
---

Audit the Cloudflare layer: tunnel connectors, DNS, and LB pool health.

## 1. Tunnel connectors

There are two connectors for tunnel `a82f24a8-f767-4a59-bc77-1d59ad132be2`:
- **Primary**: `cloudflared` systemd service on omv-main (checked via SSH)
- **HA**: `cloudflared-ha` k8s Deployment in `cloudless` namespace on omv-ha

### 1a. Primary connector (systemd)

Use `mcp__cloudless-infra__cloudflare_tunnel_status` with `tail=30`.

This SSHes to omv-main and returns:
- systemd service status (`active` or `failed`)
- Recent log lines filtered for errors/reconnects/registrations
- Active connection events

Healthy: `active (running)` + log lines showing `Registered tunnel connection`.

### 1b. HA connector (k8s)

Use `mcp__cloudless-infra__cluster_run_command` on `omv-main`:

```bash
sudo k3s kubectl get deployment cloudflared-ha -n cloudless -o wide
sudo k3s kubectl get pod -n cloudless -l app=cloudflared-ha -o wide
sudo k3s kubectl logs -n cloudless deployment/cloudflared-ha --since=10m \
  | grep -iE "error|reconnect|register|failed" | tail -20
```

Expected: `1/1 Running` on node `omv-ha`.

Flag: `0/1` or `CrashLoopBackOff` → HA connector is down; check `cloudflared-credentials` secret exists
  in `cloudless` namespace and that `omv-ha` node is Ready.

## 2. DNS records

Use `mcp__cloudless-infra__cloudflare_list_dns_records` (no filter) to list all records.

Expected CNAMEs for tunnel (all proxied=true, pointing to `a82f24a8-f767-4a59-bc77-1d59ad132be2.cfargotunnel.com`):

| Hostname | Type |
|---|---|
| cloudless.gr | CNAME (CF-flattened at apex) |
| www.cloudless.gr | CNAME |
| grafana.cloudless.gr | CNAME |
| n8n.cloudless.gr | CNAME |
| ntfy.cloudless.gr | CNAME |
| ha.cloudless.gr | CNAME |
| metrics.cloudless.gr | CNAME |
| manage.cloudless.gr | CNAME |
| auth.cloudless.gr | CNAME |
| oncall.cloudless.gr | CNAME |

Flag: missing records → DNS drift. Use `mcp__cloudless-infra__cloudflare_bulk_restore_dns` to restore.

Or verify live resolution via:
```bash
# From omv-main via cluster_run_command
dig +short grafana.cloudless.gr   # expect: a82f24a8-*.cfargotunnel.com or Cloudflare Anycast IPs
dig +short cloudless.gr
```

## 3. Cloudflare Load Balancer (if provisioned)

Use `mcp__cloudless-infra__cloudflare_list_load_balancers` then `mcp__cloudless-infra__cloudflare_list_lb_pools`.

LB topology (when provisioned):
- Primary pool: `cloudless.gr-primary` → CloudFront distribution (`d3k7muo3c6lw6s.cloudfront.net`)
- Secondary pool: `cloudless.gr-secondary` → Tailscale Funnel (`omv.tail8eb71.ts.net`)
- Steering: `off` (active-passive, primary always preferred when healthy)

If not yet provisioned, run `mcp__cloudless-infra__cloudflare_provision_lb` (dry_run=true first).

Requires `CLOUDFLARE_API_TOKEN` (token B: `gh-actions-dns-lb`) with `Zone:Load Balancing:Edit` scope
and `CLOUDFLARE_ACCOUNT_ID` set in environment.

## 4. API token health

Use `mcp__cloudless-infra__cloudflare_verify_token` first. If it returns ❌, all API-based
checks below will fail. The token must be replaced before proceeding (see CLAUDE.md steps 2–4).

## 5. Summary report format

```
CLOUDFLARE STATUS: HEALTHY / DEGRADED / DOWN

Token:
  CLOUDFLARE_API_TOKEN     ✅/❌  [valid | dead/missing]

Tunnel (a82f24a8):
  cloudflared (omv-main)   ✅/❌  [active | failed | SSH unreachable]
  cloudflared-ha (omv-ha)  ✅/❌  [Running | CrashLoop | Pending]
  Connectors registered:   N/2

DNS:
  cloudless.gr             ✅/❌  [CNAME to tunnel | NXDOMAIN | missing]
  grafana.cloudless.gr     ✅/❌
  (check all 10 subdomains)

Load Balancer:
  Primary (CloudFront)     ✅/❌/⚠️  [healthy | degraded | not provisioned]
  Secondary (Tailscale)    ✅/❌

Issues:
  - [component]: [symptom] → [recommended action]
```

Flag CRITICAL: tunnel down (zero connectors) OR DNS broken for cloudless.gr apex.
Flag DEGRADED: only one connector (HA lost), LB pool unhealthy, or DNS drift detected.
