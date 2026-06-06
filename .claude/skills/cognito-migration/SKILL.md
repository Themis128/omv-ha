---
name: cognito-migration
description: >
  Remove all Keycloak dead code from cloudless.gr and replace functional
  Keycloak Admin API calls (user registration, resend-verification) with
  AWS Cognito equivalents. Run in a session where Themis128/cloudless.gr
  is in scope. Based on live GitHub search — 23 src/ files affected.
argument-hint: "[dry-run | apply]"
allowed-tools: >
  Bash,
  Read,
  Edit,
  Write,
  Glob,
  Grep
---

# Cognito Migration Skill — cloudless.gr Keycloak Removal

Removes Keycloak dead code from the `cloudless.gr` Next.js app and replaces
the two functional Keycloak Admin API calls with Cognito equivalents.

Auth is now Cognito-only. Env vars: `NEXT_PUBLIC_COGNITO_USER_POOL_ID`,
`NEXT_PUBLIC_COGNITO_CLIENT_ID`, `COGNITO_REGION` (default `us-east-1`).

---

## Step 0 — Argument routing

- `dry-run` (or empty) → Steps 1–3 only: scan, report changes, do NOT write
- `apply` → Steps 1–5: scan, report, then apply all changes and verify

---

## Step 1 — Scan and confirm file inventory

Run these greps to confirm the current state:

```bash
# Count total references
grep -r keycloak src/ --include="*.ts" --include="*.tsx" -l | sort

# Confirm the two functional import files
grep -r "from.*keycloak-admin" src/ -l

# Confirm env var references
grep -r "KEYCLOAK_ISSUER\|KEYCLOAK_CLIENT_ID\|KEYCLOAK_ADMIN" src/ -l
```

Expected files with Keycloak references in `src/`:
- `src/lib/keycloak-admin.ts` — **DELETE**
- `src/lib/api-auth.ts` — remove KC JWKS fallback
- `src/lib/ssm-config.ts` — remove KC SSM fields
- `src/lib/amplify-config.ts` — remove NEXT_PUBLIC_KEYCLOAK_ISSUER check
- `src/lib/fetch-with-auth.ts` — comment only, update comment
- `src/lib/user-profile.ts` — comments only, update
- `src/app/[locale]/auth/login/page.tsx` — remove USE_KEYCLOAK branch
- `src/app/[locale]/auth/forgot-password/page.tsx` — comment only
- `src/app/[locale]/auth/post-login/page.tsx` — comment only
- `src/app/api/auth/register/route.ts` — **FUNCTIONAL REWRITE** (Cognito)
- `src/app/api/auth/resend-verification/route.ts` — **FUNCTIONAL REWRITE** (Cognito)
- `src/app/api/auth/[...nextauth]/route.ts` — remove signIn("keycloak") comment
- `src/app/api/admin/users/route.ts` — remove KC helpers block
- `src/app/[locale]/admin/users/page.tsx` — remove keycloak provider display branch
- `src/app/api/admin/cache/route.ts` — comment only
- `src/app/api/admin/analytics/page.tsx` — comment only
- `src/app/api/portal/me/route.ts` — comment only
- `src/app/api/portal/enroll/route.ts` — comment only
- `src/app/api/user/profile/route.ts` — comment only
- `src/app/[locale]/admin/client-portals/page.tsx` — UI text (update)
- `src/app/[locale]/admin/analytics/page.tsx` — comment only
- `src/components/store/CartSlideOver.tsx` — comment only
- `src/context/AuthContext.tsx` — comment only

Also touch:
- `Dockerfile` — remove NEXT_PUBLIC_KEYCLOAK_ISSUER and NEXT_PUBLIC_KEYCLOAK_CLIENT_ID build args
- `src/app/[locale]/privacy/page.tsx` — update privacy text: replace "Keycloak (authentication, self-hosted)" with "Amazon Cognito (authentication, AWS-managed)"

---

## Step 2 — Read the functional files before any edits

Read these four files in full before writing anything:

```
Read: src/lib/keycloak-admin.ts
Read: src/app/api/auth/register/route.ts
Read: src/app/api/auth/resend-verification/route.ts
Read: src/lib/api-auth.ts
Read: src/lib/ssm-config.ts
Read: src/app/[locale]/auth/login/page.tsx
Read: src/app/api/admin/users/route.ts
```

---

## Step 3 — Report planned changes (always run, even in dry-run)

Print a change summary before touching anything:

```
KEYCLOAK REMOVAL PLAN
=====================
DELETE:
  src/lib/keycloak-admin.ts

FUNCTIONAL REWRITE (Cognito replacement):
  src/app/api/auth/register/route.ts
  src/app/api/auth/resend-verification/route.ts

TARGETED EDITS (remove KC sections, keep Cognito):
  src/lib/api-auth.ts           — remove KEYCLOAK_ISSUER JWKS branch
  src/lib/ssm-config.ts         — remove KEYCLOAK_ADMIN_* fields
  src/lib/amplify-config.ts     — remove NEXT_PUBLIC_KEYCLOAK_ISSUER check
  src/app/[locale]/auth/login/page.tsx  — remove USE_KEYCLOAK branch
  src/app/api/admin/users/route.ts      — remove KC helpers section
  src/app/[locale]/admin/users/page.tsx — remove "keycloak" display branch
  Dockerfile                    — remove KC build args

COMMENT / TEXT UPDATES (safe, low risk):
  [list remaining files]

STOP if dry-run. Print: "Run with 'apply' to execute N changes."
```

---

## Step 4 — Apply changes (apply mode only)

### 4a. Delete `src/lib/keycloak-admin.ts`

```bash
rm src/lib/keycloak-admin.ts
```

### 4b. Rewrite `src/app/api/auth/register/route.ts`

Replace the `keycloak-admin` import and its usage with Cognito SDK calls.

**Before** (pattern to find):
```ts
import { getAdminToken, parseRealm, sendVerifyEmail } from "@/lib/keycloak-admin";
```

**After** — replace the import with Cognito SDK:
```ts
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  MessageActionType,
} from "@aws-sdk/client-cognito-identity-provider";

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION ?? "us-east-1",
});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "";
```

Replace the Keycloak user-creation call block with:
```ts
// Create user in Cognito (sends verification email automatically)
await cognitoClient.send(
  new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    UserAttributes: [
      { Name: "email", Value: email },
      { Name: "email_verified", Value: "false" },
    ],
    MessageAction: MessageActionType.SUPPRESS, // we handle email via SES
    TemporaryPassword: crypto.randomUUID(), // user must go through forgot-password
  })
);
```

> **Note:** After reading the file, adapt this to match the existing response shape and error handling. The key change is: remove `getAdminToken + parseRealm + sendVerifyEmail`, replace with `AdminCreateUserCommand`. Confirm with user if the email flow changes significantly.

### 4c. Rewrite `src/app/api/auth/resend-verification/route.ts`

Replace the `keycloak-admin` import and `sendVerifyEmail` call with:
```ts
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  MessageActionType,
} from "@aws-sdk/client-cognito-identity-provider";

// Resend: use AdminCreateUser with RESEND action
await cognitoClient.send(
  new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    MessageAction: MessageActionType.RESEND,
  })
);
```

### 4d. Edit `src/lib/api-auth.ts`

Read the file, then:
- Remove the block that constructs a JWKS URL from `KEYCLOAK_ISSUER`
- Remove `KEYCLOAK_ISSUER` env var references
- Keep only the Cognito JWKS path (`COGNITO_ISSUER` / `NEXT_PUBLIC_COGNITO_USER_POOL_ID`)
- The Cognito JWKS URL format: `https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json`

### 4e. Edit `src/lib/ssm-config.ts`

Remove these fields from the SSM config type and fetch block:
```
KEYCLOAK_ADMIN_USER
KEYCLOAK_ADMIN_PASSWORD
KEYCLOAK_ADMIN_CLIENT_ID
KEYCLOAK_ADMIN_CLIENT_SECRET
```

### 4f. Edit `src/app/[locale]/auth/login/page.tsx`

Remove:
```ts
const USE_KEYCLOAK = AUTH_PROVIDER === "keycloak" || !!process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER;
```
And remove the `USE_KEYCLOAK` conditional branch that renders the Keycloak SSO button.
Keep only `USE_COGNITO` path and email/password fallback.

### 4g. Edit `src/lib/amplify-config.ts`

Remove the `NEXT_PUBLIC_KEYCLOAK_ISSUER` check:
```ts
// Remove this:
!!process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER
```
Keep only `NEXT_PUBLIC_AUTH_PROVIDER` check.

### 4h. Edit `src/app/api/admin/users/route.ts`

Remove the entire Keycloak helpers section (marked `// Keycloak helpers (legacy fallback)`)
including `KEYCLOAK_ADMIN_CLIENT_SECRET`, `KEYCLOAK_ADMIN_USER`, and all KC-specific branches.

### 4i. Edit `src/app/[locale]/admin/users/page.tsx`

Remove:
```ts
provider === "keycloak" ? "Keycloak" : 
```
Replace with just the Cognito display or empty fallback.

### 4j. Edit `Dockerfile`

Remove:
```dockerfile
ARG NEXT_PUBLIC_KEYCLOAK_ISSUER=https://auth.cloudless.gr/realms/master
ARG NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=cloudless-app
```

### 4k. Update `src/app/[locale]/privacy/page.tsx`

Replace:
```
Keycloak (authentication, self-hosted on our infrastructure)
```
With:
```
Amazon Cognito (authentication, AWS-managed, EU region)
```

### 4l. Comment-only files

For all remaining files (see Step 1 list), update inline comments:
- Replace "Keycloak Bearer token" with "OIDC Bearer token"
- Replace "Keycloak access token" with "Cognito/OIDC access token"
- Remove references to KC-specific claims (`groups`, `realm:admin`)

---

## Step 5 — Verify

```bash
# Must return 0 results for functional code (comments are ok in docs/)
grep -r "keycloak-admin\|KEYCLOAK_ISSUER\|KEYCLOAK_ADMIN\|USE_KEYCLOAK" src/ \
  --include="*.ts" --include="*.tsx"

# Build must succeed
npm run build 2>&1 | tail -20

# Type check
npx tsc --noEmit 2>&1 | head -30
```

If build fails on missing AWS SDK package:
```bash
npm install @aws-sdk/client-cognito-identity-provider
```

---

## Step 6 — Commit and PR

```bash
git checkout -b feat/remove-keycloak-cognito-only
git add -A
git commit -m "Remove Keycloak dead code — Cognito-only auth

Auth migrated to AWS Cognito in omv-ha PR #14.
- Delete src/lib/keycloak-admin.ts
- Rewrite register + resend-verification routes to use Cognito AdminCreateUser
- Remove KEYCLOAK_* env var references from api-auth, ssm-config, login page
- Remove KC provider branch from admin/users display
- Update Dockerfile, privacy page"

# Open draft PR
gh pr create --draft \
  --title "Remove Keycloak dead code — Cognito-only auth" \
  --body "Closes out omv-ha PR #14. Replaces all Keycloak references with Cognito equivalents. Auth is now Cognito-only."
```

---

## Common gotchas

| Issue | Fix |
|---|---|
| `@aws-sdk/client-cognito-identity-provider` not installed | `npm install @aws-sdk/client-cognito-identity-provider` |
| `COGNITO_USER_POOL_ID` vs `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | Server routes use `COGNITO_USER_POOL_ID` (not public); client bundle uses `NEXT_PUBLIC_*` |
| `AdminCreateUser` requires IAM role | CI uses GitHubActionsOIDC role — ensure `cognito-idp:AdminCreateUser` is in the policy |
| e2e tests expect Keycloak SSO button | Update `e2e/auth.spec.ts` and `e2e/public-pages-deep.spec.ts` to remove KC-specific assertions |
| `signIn("keycloak")` in nextauth route comment | Comment only — no code change needed, but update the comment to `signIn("cognito")` |
