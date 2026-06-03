#!/usr/bin/env bash
# Grant IAM access key management permissions to the GitHubActionsOIDC role.
# This enables the rotate-aws-key.yml workflow to deactivate, create, and
# delete access keys for IAM users via OIDC (no long-lived credentials needed).
#
# Scope: all IAM users in account 278585680617.
# Tighten the Resource ARN if you want to limit to specific users/paths.
#
# Run with: AWS_PROFILE=<admin-profile> bash grant-iam-key-rotation.sh
set -euo pipefail

ROLE_NAME="GitHubActionsOIDC"
POLICY_NAME="IamKeyRotation"

POLICY_DOCUMENT=$(cat <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IamKeyRotation",
      "Effect": "Allow",
      "Action": [
        "iam:ListAccessKeys",
        "iam:CreateAccessKey",
        "iam:UpdateAccessKey",
        "iam:DeleteAccessKey"
      ],
      "Resource": "arn:aws:iam::278585680617:user/*"
    },
    {
      "Sid": "CloudTrailAudit",
      "Effect": "Allow",
      "Action": [
        "cloudtrail:LookupEvents"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SsmKeyStorage",
      "Effect": "Allow",
      "Action": [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:DeleteParameter"
      ],
      "Resource": "arn:aws:ssm:*:278585680617:parameter/github-actions/aws-key/*"
    }
  ]
}
EOF
)

echo "Adding inline policy '${POLICY_NAME}' to role '${ROLE_NAME}'..."
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "${POLICY_DOCUMENT}"

echo "Done. Verify with:"
echo "  aws iam get-role-policy --role-name ${ROLE_NAME} --policy-name ${POLICY_NAME}"
echo ""
echo "The rotate-aws-key.yml workflow can now:"
echo "  - Audit CloudTrail for old key usage"
echo "  - Deactivate / delete old IAM access keys"
echo "  - Create replacement keys"
echo "  - Store new credentials in SSM /github-actions/aws-key/<username>/"
