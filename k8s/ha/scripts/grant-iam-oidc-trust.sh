#!/usr/bin/env bash
# grant-iam-oidc-trust.sh
#
# Ensures the GitHub Actions OIDC identity provider exists in this AWS account
# and that the GitHubActionsOIDC role's trust policy allows any branch/ref in
# the Themis128/omv-ha repository to call sts:AssumeRoleWithWebIdentity.
#
# Covers two failure modes:
#   1. OIDC provider not yet registered in IAM (creates it)
#   2. Trust policy scoped too narrowly, e.g. refs/heads/master only (updates it)
#
# Run ONCE locally before triggering workflows from non-master branches:
#   AWS_PROFILE=admin bash k8s/ha/scripts/grant-iam-oidc-trust.sh
#
# Safe to re-run — idempotent.
set -euo pipefail

ROLE_NAME="GitHubActionsOIDC"
ACCOUNT_ID="278585680617"
OIDC_URL="https://token.actions.githubusercontent.com"
OIDC_PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
REPO="Themis128/omv-ha"
PROFILE="${AWS_PROFILE:-admin}"

# ── Step 1: ensure the GitHub OIDC identity provider exists ──────────────────
echo "Checking GitHub OIDC provider..."
if aws iam get-open-id-connect-provider \
     --open-id-connect-provider-arn "${OIDC_PROVIDER_ARN}" \
     --profile "${PROFILE}" &>/dev/null; then
  echo "  Provider already exists: ${OIDC_PROVIDER_ARN}"
else
  echo "  Not found — creating GitHub OIDC provider..."

  # Fetch the current thumbprint from GitHub's OIDC endpoint
  THUMBPRINT=$(openssl s_client -connect token.actions.githubusercontent.com:443 \
    -servername token.actions.githubusercontent.com \
    -showcerts </dev/null 2>/dev/null \
    | openssl x509 -fingerprint -noout -sha1 \
    | sed 's/.*=//; s/://g' \
    | tr '[:upper:]' '[:lower:]')

  if [[ -z "${THUMBPRINT}" ]]; then
    # Fallback to GitHub's well-known thumbprint if openssl fetch fails
    THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"
    echo "  (using well-known thumbprint fallback)"
  fi

  aws iam create-open-id-connect-provider \
    --url "${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "${THUMBPRINT}" \
    --profile "${PROFILE}"

  echo "  Created: ${OIDC_PROVIDER_ARN}"
fi

# ── Step 2: update the role trust policy to allow all refs in the repo ────────
echo ""
echo "Updating trust policy for ${ROLE_NAME}..."

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${OIDC_PROVIDER_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:${REPO}:*"
        }
      }
    }
  ]
}
EOF
)

aws iam update-assume-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-document "${TRUST_POLICY}" \
  --profile "${PROFILE}"

echo "  Trust policy updated: ${ROLE_NAME} now accepts any ref in ${REPO}"
echo ""
echo "Verify with:"
echo "  aws iam get-role --role-name ${ROLE_NAME} --query 'Role.AssumeRolePolicyDocument' --output json --profile ${PROFILE}"
