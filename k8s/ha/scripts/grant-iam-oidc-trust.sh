#!/usr/bin/env bash
# grant-iam-oidc-trust.sh
#
# Updates the GitHubActionsOIDC role trust policy so that ANY branch/ref
# in the Themis128/omv-ha repository can call sts:AssumeRoleWithWebIdentity.
#
# Background: the trust policy was initially scoped to refs/heads/master,
# which blocks OIDC auth from PR/feature branches. This script broadens the
# sub-claim condition to repo:Themis128/omv-ha:* (StringLike wildcard) while
# keeping the audience condition (sts.amazonaws.com) strict.
#
# Run ONCE locally before triggering workflows from non-master branches:
#   AWS_PROFILE=admin bash k8s/ha/scripts/grant-iam-oidc-trust.sh
#
# Safe to re-run — idempotent (update-assume-role-policy overwrites).
set -euo pipefail

ROLE_NAME="GitHubActionsOIDC"
ACCOUNT_ID="278585680617"
OIDC_PROVIDER="token.actions.githubusercontent.com"
REPO="Themis128/omv-ha"

echo "Current trust policy for ${ROLE_NAME}:"
aws iam get-role \
  --role-name "${ROLE_NAME}" \
  --query 'Role.AssumeRolePolicyDocument' \
  --output json \
  --profile "${AWS_PROFILE:-admin}"

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "${OIDC_PROVIDER}:sub": "repo:${REPO}:*"
        }
      }
    }
  ]
}
EOF
)

echo ""
echo "Updating trust policy to allow all branches in ${REPO}..."
aws iam update-assume-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-document "${TRUST_POLICY}" \
  --profile "${AWS_PROFILE:-admin}"

echo "Done. GitHubActionsOIDC can now be assumed from any ref in ${REPO}."
echo ""
echo "Verify with:"
echo "  aws iam get-role --role-name ${ROLE_NAME} --query 'Role.AssumeRolePolicyDocument' --profile ${AWS_PROFILE:-admin}"
