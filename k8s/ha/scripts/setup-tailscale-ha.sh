#!/usr/bin/env bash
# setup-tailscale-ha.sh
#
# Run ON omv-ha (192.168.1.130, Pi 3B).
# Installs Tailscale and joins the tailnet so the node gets its own
# Tailscale IP and can be SSH'd into directly (not just via subnet route).
#
# Run this AFTER setup-tailscale-main.sh has already been applied on omv-main.
# You need LAN access to omv-ha to run this (SSH from local machine or physical).
#
# ssh tbaltzakis@192.168.1.130
# bash <(curl -fsSL https://raw.githubusercontent.com/Themis128/omv-ha/master/k8s/ha/scripts/setup-tailscale-ha.sh)

set -euo pipefail

echo "=== Step 1: Install Tailscale ==="
curl -fsSL https://tailscale.com/install.sh | sh

echo ""
echo "=== Step 2: Enable + start tailscaled ==="
sudo systemctl enable --now tailscaled

echo ""
echo "=== Step 3: Join tailnet ==="
# --accept-routes: see other nodes' subnet routes (e.g. routes advertised by omv-main)
# --ssh:           enable Tailscale SSH so phone can SSH in without key
# This will print an auth URL — open it on any browser to approve the node
sudo tailscale up \
  --accept-routes \
  --ssh \
  --hostname=omv-ha

echo ""
echo "=== Step 4: Status ==="
tailscale status

echo ""
echo "========================================================"
echo "  omv-ha is now on the tailnet"
echo "========================================================"
echo ""
echo "  SSH from phone: ssh tbaltzakis@omv-ha  (MagicDNS)"
echo "  Or via TS IP:   tailscale status | grep omv-ha"
