#!/usr/bin/env bash
# grant-iam-all.sh
#
# Grants all IAM permissions required by the GitHub Actions workflows in this repo
# to the GitHubActionsOIDC role. Run ONCE from a machine with admin AWS credentials
# before running the automation workflows for the first time.
#
# Scripts run (idempotent — safe to re-run):
#   1. grant-iam-key-rotation.sh   → enables rotate-aws-key.yml
#   2. grant-iam-create-user.sh    → enables SES SMTP user provisioning
#   3. grant-iam-cognito-setup.sh  → enables apply-keycloak-removal.yml
#
# Usage:
#   AWS_PROFILE=admin bash k8s/ha/scripts/grant-iam-all.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${AWS_PROFILE:-admin}"

run_grant() {
  local script="$1"
  local description="$2"
  echo ""
  echo "─────────────────────────────────────────────────────"
  echo "  $description"
  echo "─────────────────────────────────────────────────────"
  AWS_PROFILE="$PROFILE" bash "${SCRIPT_DIR}/${script}"
}

run_grant "grant-iam-key-rotation.sh"  "1/3  IAM key rotation (rotate-aws-key.yml)"
run_grant "grant-iam-create-user.sh"   "2/3  SES SMTP user management"
run_grant "grant-iam-cognito-setup.sh" "3/3  Cognito oauth2-proxy setup (apply-keycloak-removal.yml)"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All IAM permissions granted. Next steps:"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Workflows you can now trigger (Actions tab on GitHub):"
echo ""
echo "  1. apply-keycloak-removal.yml"
echo "     Prerequisites: gh secret set TS_OAUTH_CLIENT_ID + TS_OAUTH_SECRET"
echo ""
echo "  2. rotate-aws-key.yml"
echo "     gh workflow run rotate-aws-key.yml \\"
echo "       -f iam_username=ses-smtp-prod \\"
echo "       -f old_key_id=AKIAUBXIAELU5SADA3XL \\"
echo "       -f dry_run=true   # test first, then re-run with dry_run=false"
echo ""
echo "  3. provision-cloudflare-lb.yml"
echo "     Prerequisites: gh secret set CF_LB_API_TOKEN"
echo ""
echo "Still manual (browser actions):"
echo "  - Revoke old Cloudflare token cfut_ulgWeq... in dash.cloudflare.com"
echo "  - Create Zone:DNS:Edit + LB tokens in Cloudflare dashboard"
echo "  - Create Tailscale OAuth client (admin.tailscale.com → Settings → OAuth clients)"
echo "  - Remove auth.cloudless.online CNAME from Cloudflare DNS"
echo "  - Verify login at https://manage.cloudless.online"
