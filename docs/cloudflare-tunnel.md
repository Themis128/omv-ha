# Cloudflare Tunnel — cloudless.online

Bypasses CGNAT (ISP WAN 100.80.158.201 is in 100.64.0.0/10) by creating an outbound
tunnel from omv-main to Cloudflare's edge. No port forwarding needed.

## Architecture

```
Internet
  └── Cloudflare Edge (QUIC/HTTP2 tunnel)
        └── cloudflared on omv-main (192.168.1.128)
              └── Traefik LoadBalancer VIP (192.168.1.200:18443)
                    ├── cloudless.online      → cloudless-app (Next.js)
                    ├── www.cloudless.online  → cloudless-app (Next.js)
                    └── auth.cloudless.online → keycloak
```

## Tunnel details

| Key | Value |
|-----|-------|
| Tunnel name | `cloudless-tunnel` |
| Tunnel ID | `a82f24a8-f767-4a59-bc77-1d59ad132be2` |
| Cloudflare zone | `cloudless.online` (zone `aa875388a91714c369b1e20107e643f5`) |
| Protocol | http2 (TCP fallback — more stable behind CGNAT than QUIC) |
| Installed on | omv-main (192.168.1.128) |
| Config file | `/etc/cloudflared/config.yml` |
| Credentials | `/etc/cloudflared/a82f24a8-f767-4a59-bc77-1d59ad132be2.json` |
| systemd service | `cloudflared.service` (enabled, starts on boot) |

## DNS records (cloudless.online)

| Type | Name | Target |
|------|------|--------|
| CNAME | `cloudless.online` | `a82f24a8-f767-4a59-bc77-1d59ad132be2.cfargotunnel.com` |
| CNAME | `*.cloudless.online` | `a82f24a8-f767-4a59-bc77-1d59ad132be2.cfargotunnel.com` |

All other A/AAAA records for the apex and subdomains were removed. The `auth` A record
(150.228.63.192, old deployment) was deleted — auth.cloudless.online now routes through
the tunnel to Keycloak in k3s.

## Config file (`/etc/cloudflared/config.yml`)

```yaml
tunnel: a82f24a8-f767-4a59-bc77-1d59ad132be2
credentials-file: /etc/cloudflared/a82f24a8-f767-4a59-bc77-1d59ad132be2.json
protocol: http2

ingress:
  - hostname: cloudless.online
    service: https://192.168.1.200:18443
    originRequest:
      noTLSVerify: true
  - hostname: "*.cloudless.online"
    service: https://192.168.1.200:18443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

`noTLSVerify: true` — Traefik serves its self-signed default cert on the internal VIP;
TLS termination with valid certs is handled by Traefik via cert-manager (Let's Encrypt
Route53 challenge).

## Cloudflare API credentials (stored in `.env`)

```
CLOUDFLARE_API_TOKEN=cfut_ulgWeqtefrVruAYDzE4eijmaAjki8rXUOtqYVIRJ0ec44482
CLOUDFLARE_ZONE_ID=aa875388a91714c369b1e20107e643f5
```

Token scope: Zone:DNS:Edit on cloudless.online.

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

The `*.cloudless.online` wildcard CNAME already covers new subdomains — no DNS changes needed.

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
cloudflared tunnel route dns --overwrite-dns cloudless-tunnel cloudless.online
cloudflared tunnel route dns --overwrite-dns cloudless-tunnel "*.cloudless.online"

# Install and start systemd service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```
