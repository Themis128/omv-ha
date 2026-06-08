#!/usr/bin/env bash
# setup-tailscale-main.sh
#
# Run ON omv-main (192.168.1.128, Pi 5).
# Enables subnet routing for 192.168.1.0/24 and Tailscale SSH so your
# phone can reach every LAN device (including omv-ha at .130) and SSH
# into the Pis using Tailscale auth instead of key management.
#
# Pre-req: tailscale is already installed and authenticated on omv-main.
# Check: tailscale status
#
# After running:
#   1. Open admin.tailscale.com → Machines → omv-main → "..." → Edit route settings
#   2. Approve "192.168.1.0/24"
#   3. On phone: Tailscale app → Settings → enable "Use Tailscale DNS" + "Accept routes"
#   4. SSH test: ssh tbaltzakis@100.113.41.119   (or: ssh tbaltzakis@omv-main)

set -euo pipefail

echo "=== Step 1: Enable IP forwarding ==="
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf

echo ""
echo "=== Step 2: Re-run tailscale up with subnet + SSH ==="
# --advertise-routes: expose full LAN to tailnet (phone can reach 192.168.1.0/24)
# --accept-routes:    this node also sees other nodes' advertised routes
# --ssh:              allow SSH via Tailscale auth (no key needed from phone)
sudo tailscale up \
  --advertise-routes=192.168.1.0/24 \
  --accept-routes \
  --ssh

echo ""
echo "=== Step 3: Status ==="
tailscale status

echo ""
echo "========================================================"
echo "  NEXT: approve routes in Tailscale admin console"
echo "========================================================"
echo ""
echo "  admin.tailscale.com → Machines → omv-main"
echo "  → '...' menu → Edit route settings"
echo "  → toggle ON: 192.168.1.0/24"
echo ""
echo "  Then on your phone:"
echo "    Tailscale app → Settings → Accept routes: ON"
echo ""
echo "  SSH to omv-main:  ssh tbaltzakis@100.113.41.119"
echo "  SSH to omv-ha:    ssh tbaltzakis@192.168.1.130  (via subnet route)"
echo "  Or by name:       ssh tbaltzakis@omv-main  (if MagicDNS is on)"
