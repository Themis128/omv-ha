#!/usr/bin/env bash
# create-oidc-role.sh
#
# Creates the GitHubActionsOIDC IAM role if it doesn't already exist.
# The role allows GitHub Actions OIDC tokens from Themis128/omv-ha to
# call sts:AssumeRoleWithWebIdentity (any branch/ref).
#
# Run ONCE before any other grant-iam-*.sh scripts:
#   AWS_PROFILE=admin bash k8s/ha/scripts/create-oidc-role.sh
#
# Safe to re-run — skips creation if the role already exists.
set -euo pipefail

ROLE_NAME="GitHubActionsOIDC"
ACCOUNT_ID="278585680617"
OIDC_PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
REPO="Themis128/omv-ha"
PROFILE="${AWS_PROFILE:-admin}"

# Check if role already exists
if aws iam get-role --role-name "${ROLE_NAME}" --profile "${PROFILE}" &>/dev/null; then
  echo "Role '${ROLE_NAME}' already exists — skipping creation."
  echo "To update its trust policy, run: grant-iam-oidc-trust.sh"
  exit 0
fi

echo "Creating IAM role '${ROLE_NAME}'..."

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

aws iam create-role \
  --role-name "${ROLE_NAME}" \
  --assume-role-policy-document "${TRUST_POLICY}" \
  --description "Assumed by GitHub Actions OIDC from ${REPO}" \
  --profile "${PROFILE}"

echo "Created: arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo ""
echo "Next: run grant-iam-all.sh to attach the required inline policies."
