---
description: Check cert-manager certificate status, expiry, and renewal across all namespaces
---

Audit all cert-manager Certificates in the cluster and report on expiry and health.

Use `mcp__cloudless-infra__cluster_run_command` on omv-main for each step:

1. **All certificates — status and expiry**:
   ```bash
   kubectl get certificates -A \
     -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[0].status,EXPIRY:.status.notAfter,ISSUER:.spec.issuerRef.name"
   ```

2. **Any certificate not Ready**:
   ```bash
   kubectl get certificates -A -o json \
     | jq -r '.items[] | select(.status.conditions[0].status != "True") | "\(.metadata.namespace)/\(.metadata.name) — \(.status.conditions[0].message // "no condition")"'
   ```

3. **Certificates expiring within 30 days** (cert-manager renews at 2/3 of lifetime, but verify):
   ```bash
   kubectl get certificates -A -o json | jq -r \
     '.items[] | select(.status.notAfter != null) |
      (.status.notAfter | fromdateiso8601) as $exp |
      (now + 2592000) as $cutoff |
      select($exp < $cutoff) |
      "\(.metadata.namespace)/\(.metadata.name) expires \(.status.notAfter)"'
   ```

4. **CertificateRequests in flight** (shows active issuance):
   ```bash
   kubectl get certificaterequests -A --sort-by=.metadata.creationTimestamp | tail -10
   ```

5. **cert-manager controller logs** (last 2 min, errors only):
   ```bash
   kubectl logs -n cert-manager deployment/cert-manager --since=2m \
     | grep -iE "error|failed|denied" | tail -20
   ```

**Key certificates in this cluster:**

| Cert | Namespace | Issuer | Notes |
|---|---|---|---|
| `postgres-tls` | `keycloak` | `cloudless-internal-ca` | Auto-renewed 30d before expiry |
| `cloudless-internal-ca` | `keycloak` | (self-signed ClusterIssuer) | 10yr, manual rotation |
| wildcard `*.cloudless.gr` | `cert-manager` | letsencrypt (Cloudflare DNS-01) | 90d, auto-renewed |

**Interpret results:**
- `READY=True` + expiry >30d away → healthy
- `READY=False` with `Issuing` condition → renewal in progress (normal)
- `READY=False` with `Failed` + no recent CertificateRequest → investigate issuer
- Any cert expired → immediately run `kubectl describe certificate <name> -n <ns>` for root cause

**Force early renewal** if needed:
```bash
kubectl delete secret <tls-secret-name> -n <namespace>
# cert-manager detects missing secret and reissues immediately
```
