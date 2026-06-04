#!/usr/bin/env bash
# grant-iam-cognito-setup.sh
#
# Grants the GitHubActionsOIDC role the minimum permissions needed to run
# the apply-keycloak-removal.yml workflow: create a Cognito app client for
# oauth2-proxy and read the pool ID from SSM.
#
# Run ONCE locally before the first workflow execution:
#   AWS_PROFILE=admin bash k8s/ha/scripts/grant-iam-cognito-setup.sh
#
# Verify afterwards:
#   aws iam get-role-policy \
#     --role-name GitHubActionsOIDC \
#     --policy-name CognitoOauth2ProxySetup \
#     --profile admin
set -euo pipefail

ROLE_NAME="GitHubActionsOIDC"
POLICY_NAME="CognitoOauth2ProxySetup"
ACCOUNT_ID="278585680617"
REGION="us-east-1"

POLICY_DOCUMENT=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CognitoClientManagement",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:ListUserPoolClients",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:DescribeUserPoolClient"
      ],
      "Resource": "arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/*"
    },
    {
      "Sid": "SsmPoolIdRead",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/cloudless/production/COGNITO_USER_POOL_ID"
    },
    {
      "Sid": "SsmClientSecretStorage",
      "Effect": "Allow",
      "Action": ["ssm:PutParameter", "ssm:GetParameter"],
      "Resource": [
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/cloudless/production/oauth2-proxy-client-id",
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/cloudless/production/oauth2-proxy-client-secret"
      ]
    }
  ]
}
EOF
)

echo "Adding inline policy '${POLICY_NAME}' to role '${ROLE_NAME}'..."
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "${POLICY_DOCUMENT}" \
  --profile "${AWS_PROFILE:-admin}"

echo "Done. The apply-keycloak-removal.yml workflow can now:"
echo "  - Read the Cognito pool ID from SSM /cloudless/production/COGNITO_USER_POOL_ID"
echo "  - List and create Cognito app clients in pool"
echo "  - Store/read client credentials in SSM /cloudless/production/oauth2-proxy-client-{id,secret}"
echo ""
echo "Verify with:"
echo "  aws iam get-role-policy --role-name ${ROLE_NAME} --policy-name ${POLICY_NAME} --profile ${AWS_PROFILE:-admin}"
