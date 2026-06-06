---
description: Check Cognito User Pool configuration, app clients, Lambda triggers, and MFA status
---

Audit the cloudless.gr Cognito User Pool configuration. All commands use
`AWS_PROFILE=admin` and region `us-east-1`.

```bash
POOL_ID="us-east-1_XXXXXXXXX"   # from NEXT_PUBLIC_COGNITO_USER_POOL_ID secret
```

---

## 1. Pool overview

```bash
aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  | jq '{
      name: .UserPool.Name,
      status: .UserPool.Status,
      created: .UserPool.CreationDate,
      mfa_config: .UserPool.MfaConfiguration,
      password_policy: .UserPool.Policies.PasswordPolicy,
      lambda_config: .UserPool.LambdaConfig,
      email_config: .UserPool.EmailConfiguration,
      estimated_users: .UserPool.EstimatedNumberOfUsers,
      username_attrs: .UserPool.UsernameAttributes,
      alias_attrs: .UserPool.AliasAttributes
    }'
```

**Expected configuration for cloudless.gr:**
- `mfa_config`: `OPTIONAL` (users can enable TOTP; not forced)
- `password_policy`: min 8 chars, `RequireUppercase/Numbers/Symbols: true`
- `username_attrs`: `["email"]` (sign in with email, not username)
- `status`: `Active`

## 2. App clients

```bash
aws cognito-idp list-user-pool-clients \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  | jq '.UserPoolClients[] | {client_id: .ClientId, name: .ClientName}'
```

For each client, get full config:
```bash
CLIENT_ID="XXXXXXXXXXXXXXXXXXXXXXXXXX"   # from NEXT_PUBLIC_COGNITO_CLIENT_ID secret
aws cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region us-east-1 \
  --profile admin \
  | jq '{
      name: .UserPoolClient.ClientName,
      client_id: .UserPoolClient.ClientId,
      has_secret: (.UserPoolClient.ClientSecret != null),
      token_validity: {
        access: "\(.UserPoolClient.AccessTokenValidity) \(.UserPoolClient.TokenValidityUnits.AccessToken // "hours")",
        id: "\(.UserPoolClient.IdTokenValidity) \(.UserPoolClient.TokenValidityUnits.IdToken // "hours")",
        refresh: "\(.UserPoolClient.RefreshTokenValidity) \(.UserPoolClient.TokenValidityUnits.RefreshToken // "days")"
      },
      auth_flows: .UserPoolClient.ExplicitAuthFlows,
      callback_urls: .UserPoolClient.CallbackURLs,
      logout_urls: .UserPoolClient.LogoutURLs,
      oauth_flows: .UserPoolClient.AllowedOAuthFlows,
      oauth_scopes: .UserPoolClient.AllowedOAuthScopes,
      prevent_reuse: .UserPoolClient.PreventUserExistenceErrors
    }'
```

**Expected for Next.js public client:**
- `has_secret`: `false` (public client — no secret)
- `auth_flows`: includes `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`
- `oauth_flows`: `["code"]` (authorization code + PKCE)
- `callback_urls`: includes `https://cloudless.gr/api/auth/callback/cognito`
- `prevent_reuse`: `ENABLED` (prevents username enumeration attacks)

## 3. Lambda triggers

```bash
aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  --query 'UserPool.LambdaConfig' \
  --output json
```

Common triggers in use (document yours here):
- `PostConfirmation` — runs after email verification (e.g., welcome email via SES)
- `PreTokenGeneration` — inject custom claims into JWT (e.g., roles from DynamoDB)
- `CustomMessage` — customize verification email content

If a trigger Lambda is set, verify it exists and is not throttled:
```bash
TRIGGER_ARN="arn:aws:lambda:us-east-1:278585680617:function:<name>"
aws lambda get-function --function-name "$TRIGGER_ARN" --region us-east-1 --profile admin \
  | jq '{state: .Configuration.State, last_update: .Configuration.LastUpdateStatus}'
```

## 4. MFA and advanced security

```bash
aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin
```

```bash
# Advanced security mode (adaptive auth)
aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  --query 'UserPool.UserPoolAddOns'
```

## 5. Domain / Hosted UI

```bash
aws cognito-idp describe-user-pool-domain \
  --domain "<your-cognito-domain>" \
  --region us-east-1 \
  --profile admin \
  | jq '{domain: .DomainDescription.Domain, status: .DomainDescription.Status, cloudfront: .DomainDescription.CloudFrontDistribution}'
```

## 6. Recent sign-in activity (last 24h via CloudTrail)

```bash
aws cloudtrail lookup-events \
  --region us-east-1 \
  --profile admin \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=cognito-idp.amazonaws.com \
  --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" \
  | jq '.Events[] | {time: .EventTime, event: .EventName, user: .Username}' | head -50
```

---

**Quick-flag items:**
- `has_secret: true` on the Next.js client → misconfigured (public clients must not have secrets)
- `callback_urls` missing `cloudless.gr` → auth redirects will fail
- Lambda trigger function in `Inactive` state → sign-up flow broken
- `mfa_config: OFF` → MFA entirely disabled, cannot be enabled per-user
