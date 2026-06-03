---
description: Check Cloudflare tunnel connectors, DNS resolution, and Load Balancer health for cloudless.online
---

Audit the Cloudflare layer: tunnel connectors, DNS, and LB pool health.

## 1. Tunnel connectors (k8s side)

Use `mcp__cloudless-infra__cluster_run_command` on omv-main:

```bash
# Both cloudflared deployments
kubectl get pods -n cloudless -l app=cloudflared -o wide
kubectl get pods -n cloudless -l app=cloudflared-ha -o wide
```

Expected: one `cloudflared` pod on omv, one `cloudflared-ha` pod on omv or omv-ha.
Both should be `1/1 Running`. If either is down, the tunnel has only one connector (degraded HA).

```bash
# Recent connector logs (errors, reconnects)
kubectl logs -n cloudless deployment/cloudflared --since=10m \
  | grep -iE "error|reconnect|register|failed" | tail -20
kubectl logs -n cloudless deployment/cloudflared-ha --since=10m \
  | grep -iE "error|reconnect|register|failed" | tail -20
```

## 2. Tunnel status via Cloudflare API

Use `mcp__cloudless-infra__cloudflare_tunnel_status` with `tail=30`.

Healthy state:
- `status: healthy`
- `connections: [{...}, {...}]` — two connectors registered (one per cloudflared deployment)
- No `err` fields in recent connector events

Flag: only one connector connected → HA is degraded; second cloudflared is not connecting.
Flag: zero connectors → tunnel is down; all traffic routed via IPv6 fallback or fails.

## 3. DNS resolution

Use `mcp__cloudless-infra__aws_check_health_checks` or run:

```bash
# From omv-main — verify CNAME chain resolves
dig +short grafana.cloudless.online
dig +short cloudless.online
```

Expected: CNAME to `<tunnel-id>.cfargotunnel.com` (or Cloudflare Anycast IPs for proxied records).

## 4. Cloudflare Load Balancer (if provisioned)

If `provision-cloudflare-lb.yml` has been run, check pool health via Cloudflare API:

```bash
# Replace with actual pool IDs from the workflow output
curl -s -X GET \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/load_balancers/pools" \
  -H "Authorization: Bearer ${CF_LB_API_TOKEN}" \
  | jq '.result[] | {name: .name, healthy: .healthy, origins: [.origins[] | {name: .name, healthy: .healthy}]}'
```

LB topology:
- Primary pool: CloudFront → SST/OpenNext Lambda (`cloudless.gr`)
- Secondary pool: Pi VIP `192.168.1.200` via IPv6 (failover)
- Steering: `off` (active-passive, primary always preferred when healthy)

## 5. Summary report format

```
CLOUDFLARE STATUS: HEALTHY / DEGRADED / DOWN

Tunnel (a82f24a8):
  cloudflared (omv)    ✅/❌  [Running | CrashLoop]
  cloudflared-ha       ✅/❌  [Running | missing]
  Connectors active:   N/2

DNS:
  cloudless.online     ✅/❌  [resolves to CF IPs | NXDOMAIN]
  grafana.*            ✅/❌

Load Balancer:
  Primary (CloudFront) ✅/❌/⚠️ [healthy | degraded | not provisioned]
  Secondary (Pi VIP)   ✅/❌

Issues:
  - [component]: [symptom] → [recommended action]
```

Flag CRITICAL: tunnel down (zero connectors) OR DNS broken.
Flag DEGRADED: only one connector (HA lost), LB pool unhealthy.
