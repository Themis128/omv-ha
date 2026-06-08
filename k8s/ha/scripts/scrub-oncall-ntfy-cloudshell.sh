#!/usr/bin/env bash
# scrub-oncall-ntfy-cloudshell.sh
#
# Purges the 4 OnCall/ntfy plaintext passwords (removed from HEAD in the PR #16
# follow-up, 2026-06-08) from ALL git history, then force-pushes both branches.
#
# Pairs with the in-repo remediation:
#   - k8s/oncall/scripts/create-oncall-secrets.sh      (rotates DB/Redis creds on cluster)
#   - k8s/monitoring/scripts/create-ntfy-basic-auth.sh (rotates ntfy basic-auth on cluster)
# Run those on the cluster FIRST so the live values no longer match what we scrub.
#
# Prerequisites:
#   - AWS CloudShell (or any machine with python3 + git)
#   - A GitHub PAT with repo scope
#
# Usage:
#   GITHUB_PAT="ghp_..." bash scrub-oncall-ntfy-cloudshell.sh
set -euo pipefail

REPO="Themis128/omv-ha"
PR_BRANCH="claude/node-architecture-research-fuYGh"

if [[ -z "${GITHUB_PAT:-}" ]]; then
  echo "ERROR: Set GITHUB_PAT before running:"
  echo "  GITHUB_PAT=\"ghp_...\" bash $0"
  exit 1
fi

###############################################################################
# STEP 1 — Install git-filter-repo
###############################################################################
echo ""
echo "=== Step 1: Installing git-filter-repo ==="
pip3 install git-filter-repo --user --quiet
export PATH="$HOME/.local/bin:$PATH"
git filter-repo --version

###############################################################################
# STEP 2 — Clone repo and scrub history
###############################################################################
echo ""
echo "=== Step 2: Cloning and scrubbing git history ==="

WORKDIR=$(mktemp -d)
git clone "https://${GITHUB_PAT}@github.com/${REPO}.git" "$WORKDIR/omv-ha"
cd "$WORKDIR/omv-ha"

cat > /tmp/oncall-ntfy-replacements.txt << 'REPLACEMENTS'
literal:OncallRoot2026!==>REDACTED_ONCALL_DB_ROOT_PASSWORD
literal:OncallDB2026!==>REDACTED_ONCALL_DB_PASSWORD
literal:OnCallRedis2026!==>REDACTED_ONCALL_REDIS_PASSWORD
literal:am-ntfy-2026!==>REDACTED_NTFY_BASIC_AUTH
REPLACEMENTS

git filter-repo --replace-text /tmp/oncall-ntfy-replacements.txt --force
echo "  History scrubbed."

###############################################################################
# STEP 3 — Force-push both branches
###############################################################################
echo ""
echo "=== Step 3: Force-pushing to GitHub ==="

git remote add origin "https://${GITHUB_PAT}@github.com/${REPO}.git"
git push origin master --force-with-lease
git push origin "$PR_BRANCH" --force-with-lease

###############################################################################
# DONE
###############################################################################
echo ""
echo "=== ALL DONE ==="
echo ""
echo "Verify the scrub (each should return 0 results):"
echo "  https://github.com/${REPO}/search?q=OncallDB2026"
echo "  https://github.com/${REPO}/search?q=OnCallRedis2026"
echo "  https://github.com/${REPO}/search?q=am-ntfy-2026"
echo ""
echo "If you have NOT yet rotated the live cluster secrets, do it now:"
echo "  bash k8s/oncall/scripts/create-oncall-secrets.sh"
echo "  bash k8s/monitoring/scripts/create-ntfy-basic-auth.sh"
echo "  (both print the follow-up ALTER USER / ntfy user / rollout commands)"
