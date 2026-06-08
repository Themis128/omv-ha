#!/usr/bin/env bash
# retrieve-aws-key-from-ssm.sh
#
# Run from AWS CloudShell (or locally with AWS_PROFILE=admin) AFTER
# rotate-aws-key.yml has completed with dry_run=false.
#
# Retrieves the new IAM key for ses-smtp-prod from SSM Parameter Store,
# updates the GitHub secrets AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY,
# and optionally deletes the SSM parameters (they're SecureString, but
# deletion reduces blast radius if SSM is ever compromised).
#
# Usage:
#   bash retrieve-aws-key-from-ssm.sh [--iam-username USERNAME] [--delete-ssm]
#
# Defaults:
#   --iam-username  ses-smtp-prod
#   --delete-ssm    false (keep parameters for reference)

set -euo pipefail

REPO="Themis128/omv-ha"
IAM_USERNAME="ses-smtp-prod"
DELETE_SSM=false

usage() {
  echo "Usage: $0 [--iam-username USERNAME] [--delete-ssm]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iam-username) IAM_USERNAME="$2"; shift 2 ;;
    --delete-ssm)   DELETE_SSM=true;   shift ;;
    -h|--help)      usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

SSM_PREFIX="/github-actions/aws-key/${IAM_USERNAME}"

echo "=== Retrieve new IAM key from SSM ==="
echo ""
echo "Username : ${IAM_USERNAME}"
echo "SSM path : ${SSM_PREFIX}/"
echo ""

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v aws &>/dev/null || { echo "❌ aws CLI not found"; exit 1; }
command -v gh  &>/dev/null || { echo "❌ gh CLI not found"; exit 1; }

GH_USER=$(gh api /user --jq '.login' 2>/dev/null || echo "")
[[ -z "$GH_USER" ]] && { echo "❌ gh CLI not authenticated — run: gh auth login"; exit 1; }

AWS_ID=$(aws sts get-caller-identity --query 'UserId' --output text 2>/dev/null || echo "")
[[ -z "$AWS_ID" ]] && { echo "❌ AWS not authenticated"; exit 1; }
echo "✅ AWS identity: ${AWS_ID}"
echo "✅ GitHub:       ${GH_USER}"
echo ""

# ── Retrieve from SSM ─────────────────────────────────────────────────────────
echo "Retrieving key ID from SSM..."
NEW_KEY_ID=$(aws ssm get-parameter \
  --name "${SSM_PREFIX}/access-key-id" \
  --query Parameter.Value \
  --output text 2>/dev/null || echo "")

if [[ -z "$NEW_KEY_ID" ]]; then
  echo "❌ ${SSM_PREFIX}/access-key-id not found in SSM"
  echo "   Has rotate-aws-key.yml completed with dry_run=false?"
  exit 1
fi
echo "  Key ID: ${NEW_KEY_ID}"

echo ""
echo "Retrieving secret key from SSM (SecureString — decrypting)..."
NEW_SECRET=$(aws ssm get-parameter \
  --name "${SSM_PREFIX}/secret-access-key" \
  --with-decryption \
  --query Parameter.Value \
  --output text 2>/dev/null || echo "")

if [[ -z "$NEW_SECRET" ]]; then
  echo "❌ ${SSM_PREFIX}/secret-access-key not found in SSM"
  exit 1
fi
echo "  Secret key: [retrieved — not printed]"

# ── Update GitHub secrets ─────────────────────────────────────────────────────
echo ""
echo "Updating GitHub secrets..."
gh secret set AWS_ACCESS_KEY_ID     --repo "${REPO}" --body "${NEW_KEY_ID}"
echo "  ✅ AWS_ACCESS_KEY_ID updated"
gh secret set AWS_SECRET_ACCESS_KEY --repo "${REPO}" --body "${NEW_SECRET}"
echo "  ✅ AWS_SECRET_ACCESS_KEY updated"

# Clear from memory
unset NEW_SECRET

# ── Optionally delete SSM parameters ─────────────────────────────────────────
if [[ "$DELETE_SSM" == "true" ]]; then
  echo ""
  echo "Deleting SSM parameters..."
  aws ssm delete-parameter --name "${SSM_PREFIX}/access-key-id"
  echo "  ✅ Deleted ${SSM_PREFIX}/access-key-id"
  aws ssm delete-parameter --name "${SSM_PREFIX}/secret-access-key"
  echo "  ✅ Deleted ${SSM_PREFIX}/secret-access-key"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  Done."
echo "  New key ${NEW_KEY_ID} is now set as AWS_ACCESS_KEY_ID."
echo ""
echo "  Next: wait 14 days, then run rotate-aws-key.yml"
echo "  with delete_old_key=true to permanently remove the old key."
echo "════════════════════════════════════════"
