# Compression & Security Headers

## Overview

Three hardening layers applied to the stack, all active as of 2026-05-04:

| Feature | Where | Mechanism | Status |
|---------|-------|-----------|--------|
| Brotli + gzip compression | Traefik (all websecure routes) | `compress` Middleware CRD | ✅ Active |
| HSTS + security headers | Traefik (all websecure routes) | `hsts` Middleware CRD | ✅ Active |
| WAL compression (zstd) | PostgreSQL 16 | `wal_compression=zstd` arg | ✅ Active |
| TOAST compression (lz4) | PostgreSQL 16 | `default_toast_compression=lz4` arg | ✅ Active |

---

## Brotli + Gzip Compression (`k8s/traefik/compress-middleware.yaml`)

Traefik's built-in `compress` middleware negotiates the best algorithm based on `Accept-Encoding`:
- **Brotli** (`br`) — preferred; ~20–26% better ratio than gzip on text/JSON/HTML
- **Gzip** — fallback for clients that don't support brotli

### Configuration

```yaml
# k8s/traefik/compress-middleware.yaml
spec:
  compress:
    minResponseBodyBytes: 1024   # skip compression for tiny responses
    includedContentTypes:
      - text/html, text/css, application/javascript, application/json …
```

Wired globally to the `websecure` entrypoint via `k8s/traefik/helmchartconfig.yaml`:

```yaml
additionalArguments:
  - "--entryPoints.websecure.http.middlewares=kube-system-compress@kubernetescrd,kube-system-hsts@kubernetescrd"
```

### Test

```bash
curl -skL -H "Host: auth.cloudless.gr" -H "Accept-Encoding: br, gzip" \
  -o /dev/null -D - https://192.168.1.200:18443/ | grep content-encoding
# content-encoding: br
```

---

## HSTS & Security Headers (`k8s/traefik/hsts-middleware.yaml`)

Applied globally to all HTTPS routes through Traefik.

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | 2-year HTTPS enforcement |
| `X-Frame-Options` | `DENY` | Clickjacking prevention |
| `X-Content-Type-Options` | `nosniff` | MIME-type sniffing prevention |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referrer leakage control |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Sensor API lockdown |

> **`stsPreload: false`** — Enable only after verifying all subdomains are HTTPS-only and submitting to the preload list at hstspreload.org. Hard to undo once preloaded.

### Test

```bash
curl -sk -H "Host: omv.tail8eb71.ts.net" https://192.168.1.200:18443/healthz -D - -o /dev/null \
  | grep -E "strict-transport|x-frame|x-content|referrer"
# strict-transport-security: max-age=63072000; includeSubDomains
# x-frame-options: DENY
# x-content-type-options: nosniff
# referrer-policy: strict-origin-when-cross-origin
```

### Note on HelmChartConfig middleware wiring

The Traefik Helm chart bundled with k3s does not translate `ports.websecure.middlewares` into startup args. The reliable method is `additionalArguments` with explicit `--entryPoints.websecure.http.middlewares=`.

---

## PostgreSQL WAL + TOAST Compression (`k8s/keycloak/postgres.yaml`)

| Setting | Value | Benefit |
|---------|-------|---------|
| `wal_compression` | `zstd` | ~30–50% smaller WAL files; less SD/SSD write amplification on Pi |
| `default_toast_compression` | `lz4` | Fast in-place compression for large column values (JSON, text, bytea) |

Both are server-side only — no client changes needed. Available in PostgreSQL 15+ (stack uses 16-alpine).

### Test

```bash
kubectl exec -n keycloak deploy/postgres -- \
  psql -U keycloak -d keycloak -c "SHOW wal_compression; SHOW default_toast_compression;"
# wal_compression  → zstd
# default_toast_compression → lz4
```

### Rollback

Remove the two `-c wal_compression=zstd` and `-c default_toast_compression=lz4` args from `postgres.yaml` and re-apply. No data migration needed — existing WAL and TOAST data is unaffected.

---

## Files

| Path | Description |
|------|-------------|
| `k8s/traefik/compress-middleware.yaml` | Traefik Middleware CRD — brotli + gzip |
| `k8s/traefik/hsts-middleware.yaml` | Traefik Middleware CRD — HSTS + security headers |
| `k8s/traefik/helmchartconfig.yaml` | Wires both middlewares globally via `additionalArguments` |
| `k8s/keycloak/postgres.yaml` | PostgreSQL deployment with zstd WAL + lz4 TOAST |
| `docs/key-rotation.md` | Crypto-agility runbook — key/cert rotation procedures |
