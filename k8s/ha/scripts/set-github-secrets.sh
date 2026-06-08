#!/usr/bin/env bash
# set-github-secrets.sh
#
# Run from AWS CloudShell (or any shell with gh CLI authenticated).
# Sets all 4 secrets needed for configure-tailscale.yml + kubectl-dispatch.yml.
#
# Usage:
#   bash set-github-secrets.sh \
#     --ts-client-id   "tskey-client-..." \
#     --ts-client-secret "tskey-secret-..." \
#     --ts-auth-key    "tskey-auth-..." \
#     --pi-ssh-key-file "/path/to/private_key"
#
# Where to get each value:
#   TS_OAUTH_CLIENT_ID + TS_OAUTH_SECRET:
#     admin.tailscale.com → Settings → OAuth clients → Generate
#     Scope: auth_keys (Write)
#
#   TS_AUTH_KEY:
#     admin.tailscale.com → Settings → Keys → Generate auth key
#     Check: Reusable, No expiry (or 90 days)
#     Tag: (leave blank or add tag:ci if ACL configured)
#
#   PI_SSH_KEY (private key file):
#     Run gen-ci-ssh-key.sh on omv-main → copy the private key to a file

set -euo pipefail

REPO="Themis128/omv-ha"

usage() {
  echo "Usage: $0 --ts-client-id ID --ts-client-secret SECRET --ts-auth-key KEY --pi-ssh-key-file PATH"
  exit 1
}

TS_CLIENT_ID=""
TS_CLIENT_SECRET=""
TS_AUTH_KEY=""
PI_SSH_KEY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ts-client-id)     TS_CLIENT_ID="$2";     shift 2 ;;
    --ts-client-secret) TS_CLIENT_SECRET="$2"; shift 2 ;;
    --ts-auth-key)      TS_AUTH_KEY="$2";      shift 2 ;;
    --pi-ssh-key-file)  PI_SSH_KEY_FILE="$2";  shift 2 ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$TS_CLIENT_ID" || -z "$TS_CLIENT_SECRET" || -z "$TS_AUTH_KEY" || -z "$PI_SSH_KEY_FILE" ]] && usage
[[ ! -f "$PI_SSH_KEY_FILE" ]] && { echo "ERROR: PI_SSH_KEY file not found: $PI_SSH_KEY_FILE"; exit 1; }

echo "Setting GitHub Actions secrets for ${REPO}..."
echo ""

gh secret set TS_OAUTH_CLIENT_ID   --repo "${REPO}" --body "${TS_CLIENT_ID}"
echo "✅ TS_OAUTH_CLIENT_ID"

gh secret set TS_OAUTH_SECRET      --repo "${REPO}" --body "${TS_CLIENT_SECRET}"
echo "✅ TS_OAUTH_SECRET"

gh secret set TS_AUTH_KEY          --repo "${REPO}" --body "${TS_AUTH_KEY}"
echo "✅ TS_AUTH_KEY"

gh secret set PI_SSH_KEY           --repo "${REPO}" --body "$(cat "${PI_SSH_KEY_FILE}")"
echo "✅ PI_SSH_KEY"

echo ""
echo "========================================================"
echo "  All 4 secrets set. Verify:"
echo "========================================================"
gh secret list --repo "${REPO}" | grep -E "TS_OAUTH_CLIENT_ID|TS_OAUTH_SECRET|TS_AUTH_KEY|PI_SSH_KEY"

echo ""
echo "Next: trigger the configure-tailscale workflow (test first):"
echo "  github.com/Themis128/omv-ha/actions/workflows/configure-tailscale.yml"
echo "  → target: both  |  test_only: true"
