# Cloudflare Tunnel — cloudless.gr

Bypasses CGNAT (ISP WAN 100.80.158.201 is in 100.64.0.0/10) by creating an outbound
tunnel from the Pi cluster to Cloudflare's edge. No port forwarding needed.

## Architecture

```
Internet
  └── Cloudflare Edge (QUIC/HTTP2 tunnel — tunnel ID a82f24a8)
        ├── cloudflared on omv-main (192.168.1.128) — systemd service [primary]
        └── cloudflared-ha pod on omv-ha (192.168.1.130) — k8s Deployment  [failover]
              └── Traefik LoadBalancer VIP (192.168.1.200:18443)
                    ├── cloudless.gr      → cloudless-app (Next.js)
                    ├── www.cloudless.gr  → cloudless-app (Next.js)
                    └── auth.cloudless.gr → keycloak
```

Both connectors run the same tunnel. Cloudflare automatically routes traffic through
whichever connectors are healthy — if omv-main goes down, traffic flows via omv-ha
within seconds, with no DNS changes required.

## HA connector setup (omv-ha)

The `k8s/cloudless/cloudflared-ha.yaml` manifest runs a second connector as a k8s
Deployment on omv-ha. It tolerates the `control-plane:NoSchedule` taint so it can
schedule on the HA node.

**Deploy once:**
```bash
# 1. Copy tunnel credentials from omv-main
kubectl create secret generic cloudflared-credentials \
  --namespace cloudless \
  --from-file=credentials.json=/etc/cloudflared/a82f24a8-f767-4a59-bc77-1d59ad132be2.json

# 2. Apply the manifest
kubectl apply -f k8s/cloudless/cloudflared-ha.yaml

# 3. Verify both connectors appear in Cloudflare dashboard:
#    dash.cloudflare.com → Zero Trust → Networks → Tunnels → cloudless-tunnel → Connectors
```

**Check HA connector health:**
```bash
kubectl get pods -n cloudless -l app=cloudflared-ha
kubectl logs -n cloudless -l app=cloudflared-ha --tail=20
```

## Tunnel details

| Key | Value |
|-----|-------|
| Tunnel name | `cloudless-tunnel` |
| Tunnel ID | `a82f24a8-f767-4a59-bc77-1d59ad132be2` |
| Cloudflare zone | `cloudless.gr` (zone `aa875388a91714c369b1e20107e643f5`) |
| Protocol | http2 (TCP fallback — more stable behind CGNAT than QUIC) |
| Installed on | omv-main (192.168.1.128) |
| Config file | `/etc/cloudflared/config.yml` |
| Credentials | `/etc/cloudflared/a82f24a8-f767-4a59-bc77-1d59ad132be2.json` |
| systemd service | `cloudflared.service` (enabled, starts on boot) |

## DNS records (cloudless.gr)

| Type | Name | Target |
|------|------|--------|
| CNAME | `cloudless.gr` | `a82f24a8-f767-4a59-bc77-1d59ad132be2.cfargotunnel.com` |
| CNAME | `*.cloudless.gr` | `a82f24a8-f767-4a59-bc77-1d59ad132be2.cfargotunnel.com` |

All other A/AAAA records for the apex and subdomains were removed. The `auth` A record
(150.228.63.192, old deployment) was deleted — auth.cloudless.gr now routes through
the tunnel to Keycloak in k3s.

## Config file (`/etc/cloudflared/config.yml`)

```yaml
tunnel: a82f24a8-f767-4a59-bc77-1d59ad132be2
credentials-file: /etc/cloudflared/a82f24a8-f767-4a59-bc77-1d59ad132be2.json
protocol: http2

ingress:
  - hostname: cloudless.gr
    service: https://192.168.1.200:18443
    originRequest:
      noTLSVerify: true
  - hostname: "*.cloudless.gr"
    service: https://192.168.1.200:18443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

`noTLSVerify: true` — Traefik serves its self-signed default cert on the internal VIP;
TLS termination with valid certs is handled by Traefik via cert-manager (Let's Encrypt
Route53 challenge).

## Cloudflare API credentials

> **⚠️ SECURITY:** A token was previously hardcoded here and has been exposed in git history.
> Rotate it immediately: Cloudflare dashboard → My Profile → API Tokens → Revoke.
> Create a replacement with scope `Zone:DNS:Edit` on `cloudless.gr` and store it
> in the MCP server's environment, not in this file.

```
CLOUDFLARE_API_TOKEN=<set via env — never commit>
CLOUDFLARE_ZONE_ID=aa875388a91714c369b1e20107e643f5
```

Token scope: Zone:DNS:Edit on cloudless.gr.

## Operations

### Check tunnel status
```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -f
```

### Restart tunnel
```bash
sudo systemctl restart cloudflared
```

### View live connections
```bash
sudo journalctl -u cloudflared --since "5 minutes ago" | grep -E "Registered|ERR"
```

### Add a new subdomain
1. Add an ingress rule to `/etc/cloudflared/config.yml` before the catch-all `http_status:404` line
2. Add a k8s Ingress resource in the relevant namespace pointing to Traefik
3. Restart cloudflared: `sudo systemctl restart cloudflared`

The `*.cloudless.gr` wildcard CNAME already covers new subdomains — no DNS changes needed.

### Rotate tunnel credentials
```bash
# On omv-main:
cloudflared tunnel rotate-secret cloudless-tunnel
sudo systemctl restart cloudflared
```

## Startup sequence after reboot

On boot, systemd starts cloudflared automatically. Cloudflared connects to Cloudflare's
edge before k3s is fully up, causing brief "connection refused" errors in the logs.
This is normal — the errors stop once Traefik acquires the VIP (typically 2–3 minutes
after boot).

## Installation steps (for reference)

```bash
# Download arm64 binary (Debian Trixie not in apt repo)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
sudo install cloudflared-linux-arm64 /usr/local/bin/cloudflared

# Authenticate (opens browser URL)
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create cloudless-tunnel

# Write config to /etc/cloudflared/config.yml
# Add DNS routes
cloudflared tunnel route dns --overwrite-dns cloudless-tunnel cloudless.gr
cloudflared tunnel route dns --overwrite-dns cloudless-tunnel "*.cloudless.gr"

# Install and start systemd service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```
