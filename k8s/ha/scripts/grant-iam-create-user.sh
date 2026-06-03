#!/usr/bin/env bash
# Grant iam:CreateUser (and related SES SMTP user management permissions) to the
# GitHubActionsOIDC role. This unblocks provision-ses-smtp.yml which creates a
# dedicated IAM user for SES SMTP credentials.
#
# Run with: AWS_PROFILE=<admin-profile> bash grant-iam-create-user.sh
set -euo pipefail

ROLE_NAME="GitHubActionsOIDC"
POLICY_NAME="SesSmtpUserManagement"

POLICY_DOCUMENT=$(cat <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SesSmtpUserManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreateUser",
        "iam:DeleteUser",
        "iam:GetUser",
        "iam:ListUsers",
        "iam:CreateAccessKey",
        "iam:DeleteAccessKey",
        "iam:ListAccessKeys",
        "iam:AttachUserPolicy",
        "iam:DetachUserPolicy",
        "iam:ListAttachedUserPolicies",
        "iam:PutUserPolicy",
        "iam:DeleteUserPolicy",
        "iam:TagUser"
      ],
      "Resource": "arn:aws:iam::278585680617:user/ses-smtp-*"
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
