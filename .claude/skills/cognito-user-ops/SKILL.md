---
name: cognito-user-ops
description: >
  User lifecycle management for the cloudless.online Cognito User Pool.
  Create, confirm, reset passwords, enable/disable, manage group membership, and delete users.
  Requires AWS_PROFILE=admin or appropriate IAM role.
  Use for support requests, onboarding, and account recovery.
argument-hint: "<action> <email-or-username> [options]"
allowed-tools: Bash, Read
---

# Cognito User Operations Skill

Manages user accounts in the cloudless.online Cognito User Pool (`us-east-1`).

## Step 0 — Setup

```bash
# Load pool ID (requires NEXT_PUBLIC_COGNITO_USER_POOL_ID to be known)
# Set manually if not retrievable from gh CLI:
POOL_ID="${COGNITO_POOL_ID:-us-east-1_XXXXXXXXX}"
REGION="us-east-1"
PROFILE="admin"

# Verify credentials work
aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'UserPool.Name' --output text
```

If credentials fail → check `AWS_PROFILE=admin` is configured, or assume `GitHubActionsOIDC` role.

## Step 1 — Parse arguments

From `$ARGUMENTS`, extract:
- `action`: one of `create`, `confirm`, `reset-password`, `enable`, `disable`, `delete`,
  `add-group`, `remove-group`, `info`
- `email-or-username`: the user's email address (also used as Cognito username for this pool)
- Additional options depending on action (group name, temp password, etc.)

If action is missing or ambiguous, ask the user before proceeding.

---

## Actions

### `info <email>` — Get user details

```bash
EMAIL="$1"
aws cognito-idp admin-get-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE" \
  | jq '{
      username: .Username,
      status: .UserStatus,
      enabled: .Enabled,
      created: .UserCreateDate,
      modified: .UserLastModifiedDate,
      mfa: .MFAOptions,
      preferred_mfa: .PreferredMfaSetting,
      attrs: (.UserAttributes | map({(.Name): .Value}) | add)
    }'

# Also get group membership
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'Groups[*].GroupName' --output json
```

---

### `create <email> [--temp-password <pw>] [--send-invite]` — Create a new user

```bash
EMAIL="$1"
TEMP_PW="${TEMP_PW:-TempPass$(openssl rand -hex 4)!}"

# Create user with admin-created status (FORCE_CHANGE_PASSWORD)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --temporary-password "$TEMP_PW" \
  --message-action SUPPRESS \
  --region "$REGION" --profile "$PROFILE"

# If --send-invite: omit --message-action SUPPRESS (Cognito sends welcome email)
# The email must be configured in pool's email provider (SES or Cognito default)
```

After creation:
- Status will be `FORCE_CHANGE_PASSWORD`
- Share `$TEMP_PW` with the user via secure channel (not plain text email)
- User must change password on first login

---

### `confirm <email>` — Force-confirm email without verification code

Use when a user can't receive the verification email (SES delivery issues, wrong email, etc.):

```bash
EMAIL="$1"
aws cognito-idp admin-confirm-sign-up \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE"
```

Or confirm AND set email_verified:
```bash
aws cognito-idp admin-update-user-attributes \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email_verified,Value=true \
  --region "$REGION" --profile "$PROFILE"
```

---

### `reset-password <email>` — Initiate admin password reset

Sends a password reset code to the user's email:

```bash
EMAIL="$1"
aws cognito-idp admin-reset-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE"
```

To set a specific new password directly (skips the email flow — use for support):
```bash
NEW_PW="NewSecure$(openssl rand -hex 4)!X"
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --password "$NEW_PW" \
  --permanent \
  --region "$REGION" --profile "$PROFILE"

echo "New password set: $NEW_PW"
echo "⚠️  Share via secure channel only. Rotate after user logs in."
```

---

### `enable <email>` / `disable <email>` — Toggle account access

```bash
# Disable (revokes all sessions immediately)
aws cognito-idp admin-disable-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE"

# Enable
aws cognito-idp admin-enable-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE"
```

After disable, the user's existing JWT tokens remain valid until they expire (up to 1h for access tokens).
To invalidate immediately, also sign the user out globally:
```bash
aws cognito-idp admin-user-global-sign-out \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE"
```

---

### `add-group <email> <group>` / `remove-group <email> <group>` — Group management

```bash
GROUP="admins"  # or "users", "beta", etc.

# Add to group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --group-name "$GROUP" \
  --region "$REGION" --profile "$PROFILE"

# Remove from group
aws cognito-idp admin-remove-user-from-group \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --group-name "$GROUP" \
  --region "$REGION" --profile "$PROFILE"
```

Group membership is reflected in the `cognito:groups` claim in the user's ID token.
If using a `PreTokenGeneration` Lambda, groups may be mapped to custom claims.

---

### `delete <email>` — Permanently delete a user

```bash
EMAIL="$1"
# Confirm before deleting
echo "⚠️  About to permanently delete user: $EMAIL"
echo "This cannot be undone. The user will lose access immediately."

# Check user exists first
aws cognito-idp admin-get-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'Username' --output text

# Proceed only after user confirmation
aws cognito-idp admin-delete-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --region "$REGION" --profile "$PROFILE"
```

**Never auto-delete without explicit user confirmation.** Deletion is permanent and immediate.

---

## Report format

```
COGNITO USER OPS: <action> on <email>
Pool: <pool-id> (us-east-1)

Before:
  Status: <status>  Enabled: <true/false>  Groups: [<groups>]

Action: <what was done>
Result: ✅ success / ❌ failed — <error>

After:
  Status: <status>  Enabled: <true/false>  Groups: [<groups>]

⚠️  Manual follow-up:
  - [if temp password was set]: share $TEMP_PW via secure channel
  - [if disable]: existing JWT tokens expire within 1h (or sooner if global sign-out applied)
  - [if delete]: no recovery possible
```
