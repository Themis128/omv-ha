---
name: security-audit
description: >
  Scan the repo and cluster for hardcoded secrets, exposed tokens, missing .gitignore patterns,
  Helm values with inline credentials, and k8s secrets with plaintext data.
  Run before any PR merge, after a credential incident, or on demand.
argument-hint: "[repo | cluster | full] — default full"
allowed-tools: >
  Bash,
  Read,
  mcp__cloudless-infra__cluster_run_command,
  mcp__Kubernetes_MCP_Server__kubectl_get
---

# Security Audit Skill

Scans for credential exposure across both the git repo and live cluster state.

## Step 0 — Argument routing

- empty or `full` → run both repo scan (Steps 1–3) and cluster scan (Steps 4–5)
- `repo` → run Steps 1–3 only (static analysis, no cluster access needed)
- `cluster` → run Steps 4–5 only (live cluster state)

---

## Step 1 — Git history scan for secrets

Search git history for patterns that indicate leaked credentials.

```bash
# High-entropy strings and known prefixes in all commits
git log --all --oneline | wc -l   # count commits to search

# Search current working tree
grep -rn \
  -e "AKIA[0-9A-Z]\{16\}" \
  -e "cfut_[A-Za-z0-9]\{30,\}" \
  -e "ghp_[A-Za-z0-9]\{30,\}" \
  -e "sk-[A-Za-z0-9]\{40,\}" \
  -e "xoxb-[A-Za-z0-9-]\{40,\}" \
  -e "password.*=.*['\"][^'\"]\{8,\}['\"]" \
  -e "secret.*=.*['\"][^'\"]\{8,\}['\"]" \
  -e "token.*=.*['\"][^'\"]\{20,\}['\"]" \
  --include="*.yaml" --include="*.yml" --include="*.json" --include="*.sh" \
  --exclude-dir=".git" \
  . 2>/dev/null | grep -v "REPLACE_WITH\|example\|placeholder\|your-" | head -50
```

```bash
# Search git history blobs (last 100 commits or all if small repo)
git log --all -p --since="2026-01-01" \
  | grep -E "^\+.*(AKIA[0-9A-Z]{16}|cfut_[A-Za-z0-9]{30}|ghp_[A-Za-z0-9]{36}|password.*=.*['\"][^'\"]{8,})" \
  | grep -v "REPLACE_WITH\|example\|placeholder" | head -30
```

FAIL if any real credential pattern found in working tree or recent history.
For history hits: note the commit SHA — may need `git filter-repo --replace-text`.

---

## Step 2 — Helm values and k8s manifest scan

Check all YAML files for inline credentials that should be in k8s secrets:

```bash
# Patterns that indicate hardcoded credentials in Helm values or manifests
grep -rn \
  -e "adminPassword:" \
  -e "password:" \
  -e "secretKey:" \
  -e "accessKey:" \
  -e "apiKey:" \
  -e "bearerToken:" \
  -e "basic_auth:" \
  -e "htpasswd:" \
  --include="*.yaml" --include="*.yml" \
  --exclude-dir=".git" \
  k8s/ .github/ 2>/dev/null \
  | grep -v "existingSecret\|secretKeyRef\|secretRef\|REPLACE_WITH\|#" | head -30
```

FAIL if any `adminPassword`, `password`, or `apiKey` field has a non-placeholder literal value.

Known-good exceptions (these use existingSecret references):
- `grafana.admin.existingSecret: grafana-admin-credentials` → OK
- `oncall-webhook` URL contains integration token → acceptable (webhook URL, not credential)
- `ntfy` basic_auth password in alertmanager config → FLAG (should be in k8s secret)

---

## Step 3 — .gitignore coverage check

Verify the `.gitignore` covers all sensitive file patterns:

```bash
# Check for files that should be gitignored but exist
git ls-files --others --exclude-standard | grep -E "\.(pem|key|p12|pfx|env)$|credentials\.json|kubeconfig|token\.txt"
```

```bash
# Verify required patterns exist in .gitignore
required_patterns=(".env" ".env.*" "*.pem" "*.key" "*.p12" "*.pfx" "credentials.json" "kubeconfig" "token" "token.txt" "*.tfstate")
for pattern in "${required_patterns[@]}"; do
  grep -qF "$pattern" .gitignore && echo "✅ $pattern" || echo "❌ MISSING: $pattern"
done
```

FAIL if any sensitive file is tracked by git (not gitignored).
FAIL if any required pattern is missing from `.gitignore`.

---

## Step 4 — Cluster: k8s secrets with plaintext values

Check for k8s Secrets that store credentials in easily-readable form:

```bash
# List all secrets with their type — look for Opaque secrets that might be misconfigured
kubectl get secrets -A --no-headers \
  | awk '{print $1, $2, $3}' | column -t
```

```bash
# Flag secrets with suspiciously short base64 values (may be empty or default)
kubectl get secrets -A -o json \
  | jq -r '.items[] | 
    select(.type == "Opaque") | 
    {ns: .metadata.namespace, name: .metadata.name, 
     keys: (.data // {} | keys),
     empty_keys: (.data // {} | to_entries | map(select(.value == null or .value == "")) | map(.key))
    } | 
    select(.empty_keys | length > 0) | 
    "\(.ns)/\(.name): empty keys: \(.empty_keys)"'
```

FLAG if any Opaque secret has empty values — it was created as a placeholder and never populated.
These need `kubectl edit secret` or recreation with real values.

---

## Step 5 — Cluster: RBAC and service account audit

```bash
# Service accounts with cluster-admin or admin bindings
kubectl get clusterrolebindings -o json \
  | jq -r '.items[] | 
    select(.roleRef.name == "cluster-admin") | 
    "\(.metadata.name): \(.subjects // [] | map(.kind + "/" + .name) | join(", "))"'
```

```bash
# Service accounts with wildcard permissions
kubectl get clusterroles -o json \
  | jq -r '.items[] | 
    select(.rules[]?.verbs | index("*")) |
    .metadata.name' | grep -v "^system:\|^cluster-admin\|^admin\|^edit\|^view" | head -20
```

FLAG if any non-system ClusterRoleBinding grants `cluster-admin` to a non-system service account.

---

## Report format

```
SECURITY AUDIT: CLEAN / WARNINGS / CRITICAL

Repo scan:
  Git history (secrets)    ✅/❌  [clean | N patterns found — commits: ...]
  Helm/manifest values     ✅/❌  [no inline creds | N files flagged]
  .gitignore coverage      ✅/❌  [complete | missing: <patterns>]

Cluster scan:
  k8s secrets              ✅/⚠️  [N secrets, N empty | issues]
  RBAC audit               ✅/⚠️  [no excess cluster-admin | flagged: <names>]

Critical findings (act immediately):
  - [finding]: [file/location] → [remediation command]

Warnings (address within 30 days):
  - [finding]: [context] → [recommended action]

Known acceptable items:
  - oncall-webhook integration token in alertmanager config (URL, not a credential)
```

Flag CRITICAL: active credentials in working tree or recent git history.
Flag WARNING: missing .gitignore patterns, empty secrets, excess RBAC.
