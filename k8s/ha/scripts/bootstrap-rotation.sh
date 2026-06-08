#!/usr/bin/env bash
# bootstrap-rotation.sh
#
# One-shot credential rotation + secret bootstrap for the omv-ha cluster.
# Run from any machine with: curl, jq, gh CLI (authenticated), aws CLI (optional).
#
# What this does (in order):
#   1. Set CLOUDFLARE_API_TOKEN (token B) + CLOUDFLARE_ZONE_ID  ← setup-cloudflare-tokens.sh
#   2. Trigger rotate-aws-key.yml (dry run) for ses-smtp-prod
#   3. Set CLOUDLESS_PAT + ANTHROPIC_API_KEY GitHub secrets (prompted)
#   4. Update Cognito app client callback URLs (requires aws CLI + SSM access)
#   5. Print Tailscale OAuth setup instructions
#
# Prerequisites:
#   - gh CLI authenticated: gh auth status
#   - Token A (cert-manager-dns01) and Token B (gh-actions-dns-lb) from Cloudflare dashboard:
#     dash.cloudflare.com → My Profile → API Tokens → Create Token
#     Token A scopes: Zone:DNS:Edit + Zone:Zone:Read → cloudless.gr only
#     Token B scopes: Zone:DNS:Edit + Zone:Zone:Read + Zone:LB:Edit → cloudless.gr only
#
# Usage:
#   bash bootstrap-rotation.sh \
#     --token-a  "cfXXX..."  \
#     --token-b  "cfXXX..."  \
#     [--cloudless-pat "ghp_..."] \
#     [--anthropic-key "sk-ant-..."] \
#     [--aws-rotate]          # also trigger ses-smtp-prod key rotation (dry run)
#     [--cognito]             # also update Cognito callback URLs (requires aws CLI)

set -euo pipefail

REPO="Themis128/omv-ha"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TOKEN_A=""
TOKEN_B=""
CLOUDLESS_PAT=""
ANTHROPIC_KEY=""
AWS_ROTATE=false
COGNITO=false

usage() {
  echo "Usage: $0 --token-a TOKEN_A --token-b TOKEN_B [options]"
  echo ""
  echo "Required:"
  echo "  --token-a TOKEN   cert-manager-dns01 CF token (Zone:DNS:Edit + Zone:Zone:Read)"
  echo "  --token-b TOKEN   gh-actions-dns-lb CF token  (Zone:DNS:Edit + Zone:Zone:Read + Zone:LB:Edit)"
  echo ""
  echo "Optional:"
  echo "  --cloudless-pat PAT    GitHub PAT for cloudless.gr repo (CLOUDLESS_PAT secret)"
  echo "  --anthropic-key KEY    Anthropic API key (ANTHROPIC_API_KEY secret)"
  echo "  --aws-rotate           Also trigger ses-smtp-prod IAM key rotation (dry run)"
  echo "  --cognito              Also update Cognito callback URLs (requires aws CLI)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-a)        TOKEN_A="$2";        shift 2 ;;
    --token-b)        TOKEN_B="$2";        shift 2 ;;
    --cloudless-pat)  CLOUDLESS_PAT="$2";  shift 2 ;;
    --anthropic-key)  ANTHROPIC_KEY="$2";  shift 2 ;;
    --aws-rotate)     AWS_ROTATE=true;     shift ;;
    --cognito)        COGNITO=true;        shift ;;
    -h|--help)        usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$TOKEN_A" || -z "$TOKEN_B" ]] && usage

# ── Preflight ─────────────────────────────────────────────────────────────────
echo "=== omv-ha credential bootstrap ==="
echo ""
echo "Checking prerequisites..."
command -v gh  &>/dev/null || { echo "❌ gh CLI not found — install from cli.github.com"; exit 1; }
command -v jq  &>/dev/null || { echo "❌ jq not found — install with apt/brew install jq"; exit 1; }
command -v curl &>/dev/null || { echo "❌ curl not found"; exit 1; }

GH_USER=$(gh api /user --jq '.login' 2>/dev/null || echo "")
[[ -z "$GH_USER" ]] && { echo "❌ gh CLI not authenticated — run: gh auth login"; exit 1; }
echo "✅ gh CLI authenticated as ${GH_USER}"

# ── Step 1: Cloudflare tokens ─────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
echo "STEP 1 — Cloudflare tokens + zone ID"
echo "────────────────────────────────────────"
bash "${SCRIPT_DIR}/setup-cloudflare-tokens.sh" --token-a "${TOKEN_A}" --token-b "${TOKEN_B}"

# ── Step 2: Optional secrets ──────────────────────────────────────────────────
if [[ -n "$CLOUDLESS_PAT" || -n "$ANTHROPIC_KEY" ]]; then
  echo ""
  echo "────────────────────────────────────────"
  echo "STEP 2 — Additional GitHub secrets"
  echo "────────────────────────────────────────"
fi

if [[ -n "$CLOUDLESS_PAT" ]]; then
  gh secret set CLOUDLESS_PAT --repo "${REPO}" --body "${CLOUDLESS_PAT}"
  echo "✅ CLOUDLESS_PAT set"
fi

if [[ -n "$ANTHROPIC_KEY" ]]; then
  gh secret set ANTHROPIC_API_KEY --repo "${REPO}" --body "${ANTHROPIC_KEY}"
  echo "✅ ANTHROPIC_API_KEY set"
fi

# ── Step 3: ses-smtp-prod key rotation ────────────────────────────────────────
if [[ "$AWS_ROTATE" == "true" ]]; then
  echo ""
  echo "────────────────────────────────────────"
  echo "STEP 3 — Rotate ses-smtp-prod IAM key (dry run)"
  echo "────────────────────────────────────────"
  gh workflow run rotate-aws-key.yml \
    --repo "${REPO}" \
    -f iam_username=ses-smtp-prod \
    -f old_key_id=AKIAUBXIAELU5SADA3XL \
    -f dry_run=true
  echo "✅ rotate-aws-key.yml triggered (dry_run=true)"
  echo ""
  echo "Monitor at: https://github.com/${REPO}/actions/workflows/rotate-aws-key.yml"
  echo "After dry run passes, re-run with dry_run=false to actually rotate."
  echo "Then retrieve from SSM:"
  echo "  aws ssm get-parameter --name /github-actions/aws-key/ses-smtp-prod/access-key-id --query Parameter.Value --output text"
  echo "  aws ssm get-parameter --name /github-actions/aws-key/ses-smtp-prod/secret-access-key --with-decryption --query Parameter.Value --output text"
fi

# ── Step 4: Cognito callback URLs ─────────────────────────────────────────────
if [[ "$COGNITO" == "true" ]]; then
  echo ""
  echo "────────────────────────────────────────"
  echo "STEP 4 — Update Cognito callback URLs"
  echo "────────────────────────────────────────"
  if ! command -v aws &>/dev/null; then
    echo "❌ aws CLI not found — run this step from AWS CloudShell"
  else
    POOL_ID=$(aws ssm get-parameter \
      --name /cloudless/production/COGNITO_USER_POOL_ID \
      --query Parameter.Value --output text 2>/dev/null || echo "")
    if [[ -z "$POOL_ID" ]]; then
      echo "❌ Cannot read COGNITO_USER_POOL_ID from SSM — ensure AWS credentials have SSM:GetParameter"
    else
      aws cognito-idp update-user-pool-client \
        --user-pool-id "${POOL_ID}" \
        --client-id 63d3fu5lp057694h0t70je4jk0 \
        --callback-urls "https://manage.cloudless.gr/oauth2/callback" \
        --logout-urls "https://manage.cloudless.gr" \
        --region us-east-1
      echo "✅ Cognito client 63d3fu5lp057694h0t70je4jk0 callbacks updated → manage.cloudless.gr"
    fi
  fi
fi

# ── Final summary ─────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  Bootstrap complete. Remaining steps:"
echo "════════════════════════════════════════"
echo ""
echo "  10. Tailscale OAuth client:"
echo "      admin.tailscale.com → Settings → OAuth clients → Generate"
echo "      Scope: auth_keys (Write) — copy client ID + secret, then:"
echo "      bash ${SCRIPT_DIR}/set-github-secrets.sh --ts-client-id ... --ts-client-secret ..."
echo ""
echo "  11. cluster-apply Pass 2 (after Tailscale + manage.cloudless.gr ready):"
echo "      gh workflow run apply-keycloak-removal.yml --repo ${REPO} \\"
echo "        -f skip_cognito_client=true \\"
echo "        -f cognito_client_id=63d3fu5lp057694h0t70je4jk0 \\"
echo "        -f apply_cluster=true"
echo ""
echo "  12. Restore cloudless.gr DNS records (use /cloudflare-status then cloudflare_bulk_restore_dns)"
echo ""
echo "  13. Merge PR #16: https://github.com/${REPO}/pull/16"
