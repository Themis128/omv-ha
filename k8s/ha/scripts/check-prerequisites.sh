#!/usr/bin/env bash
# check-prerequisites.sh
#
# Run locally before bootstrap-rotation.sh to verify everything is in place.
# Exit code 0 = all required checks pass; non-zero = something is missing.
#
# Usage:
#   bash check-prerequisites.sh

set -euo pipefail

REPO="Themis128/omv-ha"
PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✅  $*"; ((PASS++)); }
fail() { echo "  ❌  $*"; ((FAIL++)); }
warn() { echo "  ⚠️   $*"; ((WARN++)); }
section() { echo ""; echo "── $* ──────────────────────────────────────────"; }

echo "=== bootstrap-rotation.sh prerequisites ==="

# ── Required CLIs ─────────────────────────────────────────────────────────────
section "Required tools"

if command -v gh &>/dev/null; then
  ok "gh CLI: $(gh --version 2>&1 | head -1)"
else
  fail "gh CLI not found — install from https://cli.github.com"
fi

if command -v jq &>/dev/null; then
  ok "jq: $(jq --version 2>&1)"
else
  fail "jq not found — apt install jq / brew install jq"
fi

if command -v curl &>/dev/null; then
  ok "curl: $(curl --version 2>&1 | head -1)"
else
  fail "curl not found"
fi

# ── gh authentication ─────────────────────────────────────────────────────────
section "GitHub CLI auth"

if command -v gh &>/dev/null; then
  GH_USER=$(gh api /user --jq '.login' 2>/dev/null || echo "")
  if [[ -n "$GH_USER" ]]; then
    ok "Authenticated as: ${GH_USER}"
    # Check repo access
    if gh api "/repos/${REPO}" --jq '.full_name' &>/dev/null; then
      ok "Repo access: ${REPO}"
    else
      fail "Cannot access ${REPO} — check token scopes (needs repo + write:org)"
    fi
  else
    fail "gh CLI not authenticated — run: gh auth login"
  fi
else
  warn "Skipping gh auth check (gh not installed)"
fi

# ── GitHub secrets / variables ────────────────────────────────────────────────
section "GitHub secrets (current state)"

if command -v gh &>/dev/null && [[ -n "${GH_USER:-}" ]]; then
  CF_TOKEN=$(gh secret list --repo "${REPO}" --json name --jq '.[].name' 2>/dev/null | grep -c "CLOUDFLARE_API_TOKEN" || echo "0")
  ZONE_VAR=$(gh variable list --repo "${REPO}" --json name --jq '.[].name' 2>/dev/null | grep -c "CLOUDFLARE_ZONE_ID" || echo "0")
  AWS_KEY=$(gh secret list --repo "${REPO}" --json name --jq '.[].name' 2>/dev/null | grep -c "AWS_ACCESS_KEY_ID" || echo "0")
  TS_OAUTH=$(gh secret list --repo "${REPO}" --json name --jq '.[].name' 2>/dev/null | grep -c "TS_OAUTH_CLIENT_ID" || echo "0")

  [[ "$CF_TOKEN" -gt 0 ]] \
    && warn "CLOUDFLARE_API_TOKEN already set (will be overwritten by bootstrap)" \
    || ok  "CLOUDFLARE_API_TOKEN: not set (expected — bootstrap will set it)"

  [[ "$ZONE_VAR" -gt 0 ]] \
    && warn "CLOUDFLARE_ZONE_ID already set (will be overwritten if zone changes)" \
    || ok  "CLOUDFLARE_ZONE_ID: not set (expected — bootstrap will set it)"

  [[ "$AWS_KEY" -gt 0 ]] \
    && ok  "AWS_ACCESS_KEY_ID: present" \
    || warn "AWS_ACCESS_KEY_ID: not set (needs key rotation after bootstrap)"

  [[ "$TS_OAUTH" -gt 0 ]] \
    && ok  "TS_OAUTH_CLIENT_ID: present" \
    || warn "TS_OAUTH_CLIENT_ID: not set (needed for cluster-apply Pass 2)"
else
  warn "Skipping secret check (gh not available/authenticated)"
fi

# ── Optional: aws CLI ─────────────────────────────────────────────────────────
section "Optional tools"

if command -v aws &>/dev/null; then
  ok "aws CLI: $(aws --version 2>&1)"
  # Try to check AWS identity
  AWS_ID=$(aws sts get-caller-identity --query 'UserId' --output text 2>/dev/null || echo "")
  if [[ -n "$AWS_ID" ]]; then
    ok "AWS authenticated — needed for --cognito flag"
  else
    warn "aws CLI found but not authenticated — --cognito flag will fail (use AWS CloudShell instead)"
  fi
else
  warn "aws CLI not found — skip --cognito flag; run Cognito update from AWS CloudShell"
fi

# ── Cloudflare tokens (can't check — need them in hand) ───────────────────────
section "Cloudflare tokens (manual checklist)"
echo "  You need TWO tokens from dash.cloudflare.com → My Profile → API Tokens:"
echo ""
echo "  Token A  cert-manager-dns01"
echo "    Scopes:  Zone:DNS:Edit + Zone:Zone:Read"
echo "    Zone:    cloudless.gr only (not All Zones)"
echo "    Pass as: --token-a"
echo ""
echo "  Token B  gh-actions-dns-lb"
echo "    Scopes:  Zone:DNS:Edit + Zone:Zone:Read + Zone:Load Balancing:Edit"
echo "    Zone:    cloudless.gr only"
echo "    Pass as: --token-b"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  Results: ${PASS} passed  ${WARN} warnings  ${FAIL} failed"
echo "════════════════════════════════════════"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "Fix the ${FAIL} failed check(s) above before running bootstrap-rotation.sh"
  exit 1
elif [[ "$WARN" -gt 0 ]]; then
  echo "Ready to run bootstrap-rotation.sh (review warnings above)"
  exit 0
else
  echo "All checks passed — ready to run bootstrap-rotation.sh"
  exit 0
fi
