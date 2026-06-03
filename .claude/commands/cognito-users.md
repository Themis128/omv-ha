---
description: Search, list, and inspect Cognito users in the cloudless.online User Pool
---

Query users in the cloudless.online Cognito User Pool. All commands run locally
with `AWS_PROFILE=admin` and region `us-east-1`.

The User Pool ID is stored as the GitHub secret `NEXT_PUBLIC_COGNITO_USER_POOL_ID`
in `Themis128/cloudless.gr`. Retrieve it first if not already known:

```bash
# Get Pool ID (requires gh CLI and repo access)
POOL_ID=$(gh secret list --repo Themis128/cloudless.gr \
  | grep NEXT_PUBLIC_COGNITO_USER_POOL_ID | awk '{print $1}')
# Or: set it manually
POOL_ID="us-east-1_XXXXXXXXX"
```

---

## 1. List all users (paginated)

```bash
aws cognito-idp list-users \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  --output table \
  --query 'Users[*].{Username:Username,Email:Attributes[?Name==`email`].Value|[0],Status:UserStatus,Enabled:Enabled,Created:UserCreateDate}'
```

## 2. Search users by email

```bash
EMAIL="user@example.com"
aws cognito-idp list-users \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  --filter "email = \"$EMAIL\"" \
  --output json \
  | jq '.Users[] | {username: .Username, status: .UserStatus, enabled: .Enabled, attrs: (.Attributes | map({(.Name): .Value}) | add)}'
```

## 3. Get a single user's full details

```bash
USERNAME="user@example.com"   # or Cognito sub UUID
aws cognito-idp admin-get-user \
  --user-pool-id "$POOL_ID" \
  --username "$USERNAME" \
  --region us-east-1 \
  --profile admin \
  | jq '{username: .Username, status: .UserStatus, enabled: .Enabled, mfa: .MFAOptions, attrs: (.UserAttributes | map({(.Name): .Value}) | add)}'
```

## 4. List groups the user belongs to

```bash
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id "$POOL_ID" \
  --username "$USERNAME" \
  --region us-east-1 \
  --profile admin \
  --output table
```

## 5. Count users by status

```bash
aws cognito-idp list-users \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  | jq '.Users | group_by(.UserStatus) | map({status: .[0].UserStatus, count: length})'
```

## 6. Find recently created users (last 7 days)

```bash
CUTOFF=$(date -u -d "7 days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)   # macOS fallback

aws cognito-idp list-users \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  | jq --arg cutoff "$CUTOFF" \
    '.Users[] | select(.UserCreateDate > $cutoff) | {username: .Username, created: .UserCreateDate, status: .UserStatus}'
```

## 7. List all groups in the pool

```bash
aws cognito-idp list-groups \
  --user-pool-id "$POOL_ID" \
  --region us-east-1 \
  --profile admin \
  --output table
```

---

**User status meanings:**

| Status | Meaning |
|---|---|
| `CONFIRMED` | Email verified, account active |
| `UNCONFIRMED` | Created but email not yet verified |
| `FORCE_CHANGE_PASSWORD` | Admin-created, must set password on first login |
| `RESET_REQUIRED` | Password reset initiated |
| `DISABLED` | Account explicitly disabled |
| `ARCHIVED` | Soft-deleted |
