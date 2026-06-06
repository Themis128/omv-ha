#!/usr/bin/env bash
# security-scrub-cloudshell.sh
#
# Run this entirely from AWS CloudShell.
# Does three things in order:
#   1. Rotates the exposed omv-main-cli AWS IAM key
#   2. Scrubs all 5 credential strings from git history
#   3. Force-pushes master + PR branch to GitHub
#
# Prerequisites:
#   - AWS CloudShell (credentials pre-configured, no --profile needed)
#   - A GitHub PAT with repo scope (github.com → Settings → Developer settings
#     → Personal access tokens → Generate new token (classic), scope: repo)
#
# Usage:
#   chmod +x security-scrub-cloudshell.sh
#   GITHUB_PAT="ghp_..." bash security-scrub-cloudshell.sh

set -euo pipefail

###############################################################################
# CONFIG
###############################################################################
OLD_AWS_KEY_ID="AKIAUBXIAELUYMUPWXLG"
IAM_USER="omv-main-cli"
REPO="Themis128/omv-ha"
PR_BRANCH="claude/node-architecture-research-fuYGh"

if [[ -z "${GITHUB_PAT:-}" ]]; then
  echo "ERROR: Set GITHUB_PAT before running:"
  echo "  GITHUB_PAT=\"ghp_...\" bash $0"
  exit 1
fi

###############################################################################
# STEP 1 — Rotate AWS IAM key
###############################################################################
echo ""
echo "=== Step 1: Rotating IAM key for $IAM_USER ==="

# Deactivate old key
aws iam update-access-key \
  --user-name "$IAM_USER" \
  --access-key-id "$OLD_AWS_KEY_ID" \
  --status Inactive
echo "  Deactivated $OLD_AWS_KEY_ID"

# Create new key
NEW_KEY_JSON=$(aws iam create-access-key --user-name "$IAM_USER")
NEW_KEY_ID=$(echo "$NEW_KEY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
NEW_SECRET=$(echo "$NEW_KEY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")

echo ""
echo "  ✅ New AWS key created:"
echo "     Key ID : $NEW_KEY_ID"
echo "     Secret : $NEW_SECRET"
echo ""
echo "  Save these — you will need them to update k8s secrets on the cluster:"
echo "    kubectl create secret generic duckdb-api-secrets -n analytics \\"
echo "      --from-literal=AWS_ACCESS_KEY_ID=\"$NEW_KEY_ID\" \\"
echo "      --from-literal=AWS_SECRET_ACCESS_KEY=\"$NEW_SECRET\" \\"
echo "      --dry-run=client -o yaml | kubectl apply -f -"
echo ""
echo "    kubectl create secret generic aws-creds -n maintenance \\"
echo "      --from-literal=AWS_ACCESS_KEY_ID=\"$NEW_KEY_ID\" \\"
echo "      --from-literal=AWS_SECRET_ACCESS_KEY=\"$NEW_SECRET\" \\"
echo "      --dry-run=client -o yaml | kubectl apply -f -"
echo ""
echo "  After 14 days of verified operation, delete the old key:"
echo "    aws iam delete-access-key --user-name $IAM_USER --access-key-id $OLD_AWS_KEY_ID"

###############################################################################
# STEP 2 — Install git-filter-repo
###############################################################################
echo ""
echo "=== Step 2: Installing git-filter-repo ==="
pip3 install git-filter-repo --user --quiet
export PATH="$HOME/.local/bin:$PATH"
git filter-repo --version

###############################################################################
# STEP 3 — Clone repo and scrub history
###############################################################################
echo ""
echo "=== Step 3: Cloning and scrubbing git history ==="

WORKDIR=$(mktemp -d)
git clone "https://${GITHUB_PAT}@github.com/${REPO}.git" "$WORKDIR/omv-ha"
cd "$WORKDIR/omv-ha"

cat > /tmp/replacements.txt << 'REPLACEMENTS'
literal:REDACTED_ANTHROPIC_KEY==>REDACTED_ANTHROPIC_KEY
literal:REDACTED_NOTION_TOKEN==>REDACTED_NOTION_TOKEN
literal:REDACTED_SLACK_WEBHOOK_TOKEN==>REDACTED_SLACK_WEBHOOK_TOKEN
literal:REDACTED_AWS_SECRET_OMVMAINCLI==>REDACTED_AWS_SECRET_OMVMAINCLI
literal:REDACTED_N8N_ENCRYPTION_KEY==>REDACTED_N8N_ENCRYPTION_KEY
REPLACEMENTS

git filter-repo --replace-text /tmp/replacements.txt --force
echo "  History scrubbed."

###############################################################################
# STEP 4 — Force-push both branches
###############################################################################
echo ""
echo "=== Step 4: Force-pushing to GitHub ==="

git remote add origin "https://${GITHUB_PAT}@github.com/${REPO}.git"
git push origin master --force-with-lease
git push origin "$PR_BRANCH" --force-with-lease

echo ""
echo "=== ALL DONE ==="
echo ""
echo "Remaining manual steps (browser only):"
echo "  1. Anthropic API key → console.anthropic.com → API Keys → revoke old, create new"
echo "  2. Notion token      → notion.so/my-integrations → revoke old, create new"
echo "  3. Slack webhook     → api.slack.com/apps → Incoming Webhooks → revoke old"
echo "  4. n8n encryption key → kubectl create secret on cluster with new value"
echo ""
echo "Verify history scrub:"
echo "  https://github.com/${REPO}/search?q=sk-ant-api03-KRgAlZ35"
echo "  (should return 0 results)"
