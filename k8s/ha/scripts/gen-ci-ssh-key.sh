#!/usr/bin/env bash
# gen-ci-ssh-key.sh
#
# Run ON omv-main (192.168.1.128).
# Generates a dedicated CI SSH key, adds the public key to
# tbaltzakis's authorized_keys, and prints the private key for
# you to paste as the PI_SSH_KEY GitHub secret.
#
# Usage (from any device on LAN):
#   ssh tbaltzakis@192.168.1.128 "bash -s" < gen-ci-ssh-key.sh
#
# Or copy the script first:
#   scp gen-ci-ssh-key.sh tbaltzakis@192.168.1.128:~/ && ssh tbaltzakis@192.168.1.128 bash gen-ci-ssh-key.sh

set -euo pipefail

KEY_FILE="$HOME/.ssh/github_actions_ci"
COMMENT="github-actions-ci@omv-ha"

echo "=== Generating CI SSH key on $(hostname) ==="

# Generate if not already present
if [[ -f "${KEY_FILE}" ]]; then
  echo "Key already exists at ${KEY_FILE} — using existing key."
else
  ssh-keygen -t ed25519 -C "${COMMENT}" -f "${KEY_FILE}" -N ""
  echo "Key generated: ${KEY_FILE}"
fi

# Ensure authorized_keys exists
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"

# Add public key if not already there
PUB=$(cat "${KEY_FILE}.pub")
if grep -qF "${PUB}" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  echo "Public key already in authorized_keys — no change."
else
  echo "${PUB}" >> "$HOME/.ssh/authorized_keys"
  echo "Public key added to authorized_keys."
fi

echo ""
echo "========================================================"
echo "  PUBLIC KEY (for reference only — already installed)"
echo "========================================================"
cat "${KEY_FILE}.pub"

echo ""
echo "========================================================"
echo "  PRIVATE KEY — paste this as PI_SSH_KEY GitHub secret"
echo "========================================================"
cat "${KEY_FILE}"
echo ""
echo "  → github.com/Themis128/omv-ha/settings/secrets/actions"
echo "  → Name: PI_SSH_KEY"
echo "  → Value: paste the entire private key above (including BEGIN/END lines)"
