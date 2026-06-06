---
name: tailscale-oauth-setup
description: >
  Set up the three GitHub secrets needed for CI-to-cluster access via Tailscale:
  TS_OAUTH_CLIENT_ID, TS_OAUTH_SECRET, and PI_SSH_KEY. Once set, the
  kubectl-dispatch workflow and any cluster-apply job can reach omv-main
  remotely without VPN or physical access. Run when cluster access from CI
  is needed for the first time or after a secret rotation.
allowed-tools: Bash
---

# Tailscale OAuth Setup

Configures CI → cluster access. After completing this, you can run kubectl
commands from GitHub Actions via `kubectl-dispatch.yml` and trigger any
cluster-apply workflow without local network access.

Required secrets:
- `TS_OAUTH_CLIENT_ID` + `TS_OAUTH_SECRET` — create Tailscale ephemeral CI node
- `PI_SSH_KEY` — SSH private key for tbaltzakis@omv-main

---

## Step 1 — Check what's already set

```bash
gh secret list --repo themis128/omv-ha
```

If `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and `PI_SSH_KEY` are all listed → skip to Step 5 (test).

---

## Step 2 — Create Tailscale OAuth client

1. Open https://login.tailscale.com/admin/settings/oauth
2. Click **Generate OAuth client**
3. Set scope: **auth_keys** → enable **Write**
4. Click **Generate**
5. Save the **Client ID** (`tskey-client-...`) and **Secret** (`tskey-secret-...`)

---

## Step 3 — Add `tag:ci` to tailnet ACL

1. Open https://login.tailscale.com/admin/acls
2. Find the `tagOwners` block and add:
   ```json
   "tagOwners": {
     "tag:ci": ["autogroup:admin"]
   }
   ```
3. Save

---

## Step 4 — Set secrets

### Tailscale secrets

```bash
gh secret set TS_OAUTH_CLIENT_ID --repo themis128/omv-ha --body "tskey-client-..."
gh secret set TS_OAUTH_SECRET     --repo themis128/omv-ha --body "tskey-secret-..."
```

### SSH key for omv-main

#### Check if PI_SSH_KEY is already set
```bash
gh secret list --repo themis128/omv-ha | grep PI_SSH_KEY
```

#### If NOT set — generate a new key pair
```bash
ssh-keygen -t ed25519 -C "github-actions-ci" -f ~/.ssh/omv_ci_key -N ""
```

Add the public key to omv-main's authorized_keys.
**Option A** — if you have temporary local network access:
```bash
ssh-copy-id -i ~/.ssh/omv_ci_key.pub tbaltzakis@192.168.1.128
```

**Option B** — if omv-main already has another key and Tailscale is working,
append via an existing workflow run or ask someone with access.

Then store the private key:
```bash
gh secret set PI_SSH_KEY --repo themis128/omv-ha --body "$(cat ~/.ssh/omv_ci_key)"
```

---

## Step 5 — Test connectivity

```bash
# Dry run (no actual connection, just confirms workflow parses)
gh workflow run kubectl-dispatch.yml \
  --repo themis128/omv-ha \
  -f command="get nodes -o wide" \
  -f dry_run=true

# Live run (connects via Tailscale, runs kubectl on omv-main)
gh workflow run kubectl-dispatch.yml \
  --repo themis128/omv-ha \
  -f command="get nodes -o wide" \
  -f dry_run=false
```

Check the result at: https://github.com/Themis128/omv-ha/actions/workflows/kubectl-dispatch.yml

---

## Step 6 — Delete keycloak namespace

Once connectivity is confirmed:

```bash
gh workflow run kubectl-dispatch.yml \
  --repo themis128/omv-ha \
  -f command="delete namespace keycloak --ignore-not-found" \
  -f dry_run=false
```

---

## Common issues

| Error | Fix |
|---|---|
| `dial tcp: lookup omv: no such host` | Tailscale DNS not resolving — check tailnet ACL `tagOwners` for `tag:ci` |
| `Permission denied (publickey)` | `PI_SSH_KEY` public key not in omv-main `~/.ssh/authorized_keys` |
| `OAuth client not authorized for auth_keys` | OAuth client missing `auth_keys` write scope — recreate at admin.tailscale.com |
| `tag:ci is not a valid tag` | Tag not added to tailnet ACL `tagOwners` |
| Namespace stuck in `Terminating` | Run: `kubectl patch namespace keycloak -p '{"spec":{"finalizers":[]}}' --type=merge` |
