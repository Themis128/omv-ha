# cloudless-infra MCP server

MCP server backing the `/cloudflare-status`, `/health-check`, `/etcd-status`,
`/cert-check`, and related slash commands. Exposes Cloudflare, AWS (Lambda,
SSM, IAM, Cognito), and Pi-cluster (SSH/kubectl) tools.

## Registration

Auto-registered for any session opened at the repo root via `../.mcp.json`:

```json
{ "mcpServers": { "cloudless-infra": {
    "command": "node",
    "args": ["cloudless-infra-mcp-server/dist/index.js"] } } }
```

Build before first use (the committed `dist/` is kept in sync, but rebuild after
editing `src/`):

```bash
cd cloudless-infra-mcp-server && pnpm install && pnpm run build
```

The server starts with **no** env vars (tools fail gracefully at call time if a
credential is missing), so registration is safe in any environment — including
the remote web container, which simply can't reach the LAN or AWS.

## Required environment per tool group

Env is read at **call time** and inherited from the launching shell.

| Tool group | Needs | Default if unset |
|---|---|---|
| `cloudflare_*` (API) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID` | none — API calls fail |
| `cloudflare_bootstrap_two_tokens` | Cloudflare **Global API Key** + email (passed as tool args) | — |
| `cluster_*`, `cloudflare_tunnel_status`, SSH tools | `~/.ssh/id_ed25519` (or `PI_SSH_KEY_PATH`); reaches `OMV_MAIN_HOST` (192.168.1.128) / `OMV_HA_HOST` (192.168.1.130) over `PI_SSH_PORT` as `PI_SSH_USER` (tbaltzakis) | LAN IPs / port 22 / tbaltzakis |
| `aws_*` | ambient AWS creds (`AWS_PROFILE=admin` or OIDC role); `AWS_REGION`, `SSM_PREFIX` | us-east-1 / `/cloudless/production` |

### Where `/cloudflare-status` can actually run

- ✅ **Local machine / VPN host** with the SSH key + a live `CLOUDFLARE_API_TOKEN`.
- ❌ **Remote web session** (isolated cloud container): no LAN line-of-sight, no
  token — the tools register but every call fails. Run the skill locally instead.
