import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, } from "../constants.js";
const CF_API = "https://api.cloudflare.com/client/v4";
// Zone-scoped fetch
async function cfFetch(path, options = {}) {
    const res = await fetch(`${CF_API}/zones/${CLOUDFLARE_ZONE_ID}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
        },
    });
    return res.json();
}
// Generic API fetch (user/account-scoped)
async function cfApiFetch(path, options = {}) {
    const res = await fetch(`${CF_API}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
        },
    });
    return res.json();
}
function cfError(data) {
    return data.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
}
export function registerCloudflareTools(server) {
    // ── cloudflare_list_dns_records ───────────────────────────────────────────
    server.registerTool("cloudflare_list_dns_records", {
        title: "Cloudflare — List DNS Records",
        description: `List all DNS records for cloudless.gr.
Returns record ID, type, name, content, TTL, and proxied status.
Always run this before adding or deleting records to check current state.`,
        inputSchema: z.object({
            type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS"]).optional(),
            name: z.string().optional().describe('e.g. "auth.cloudless.gr"'),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ type, name }) => {
        const params = new URLSearchParams();
        if (type)
            params.set("type", type);
        if (name)
            params.set("name", name);
        const query = params.size ? `?${params}` : "";
        const data = (await cfFetch(`/dns_records${query}`));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
            return { content: [{ type: "text", text: "No DNS records found." }] };
        const rows = data.result.map((r) => `${r.id}  ${r.type.padEnd(6)}  ${r.name.padEnd(40)}  ${r.content}  TTL=${r.ttl}  proxied=${r.proxied}`);
        return {
            content: [
                {
                    type: "text",
                    text: `DNS records (${data.result.length}):\n\n${rows.join("\n")}`,
                },
            ],
        };
    });
    // ── cloudflare_add_dns_record ─────────────────────────────────────────────
    server.registerTool("cloudflare_add_dns_record", {
        title: "Cloudflare — Add DNS Record",
        description: `Add a new DNS record to cloudless.gr.
Supports A, AAAA, CNAME, TXT. For tunnel CNAMEs use content="<tunnel-id>.cfargotunnel.com".`,
        inputSchema: z.object({
            type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
            name: z.string().describe('Use "@" for apex or subdomain name'),
            content: z.string(),
            ttl: z.number().int().default(1).describe("1 = Cloudflare auto"),
            proxied: z.boolean().default(true),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ type, name, content, ttl, proxied }) => {
        const data = (await cfFetch("/dns_records", {
            method: "POST",
            body: JSON.stringify({ type, name, content, ttl, proxied }),
        }));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        const r = data.result;
        return {
            content: [
                {
                    type: "text",
                    text: `✅ Created ${r.type} "${r.name}" → ${r.content} (ID: ${r.id})`,
                },
            ],
        };
    });
    // ── cloudflare_update_dns_record ──────────────────────────────────────────
    server.registerTool("cloudflare_update_dns_record", {
        title: "Cloudflare — Update DNS Record",
        description: `Update an existing DNS record by ID. Only provided fields are changed.
Use cloudflare_list_dns_records first to get the record ID.`,
        inputSchema: z.object({
            record_id: z.string().describe("32-char hex record ID from list"),
            content: z.string().optional().describe("New IP / target / TXT value"),
            ttl: z.number().int().optional(),
            proxied: z.boolean().optional(),
            name: z.string().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ record_id, ...fields }) => {
        const data = (await cfFetch(`/dns_records/${record_id}`, {
            method: "PATCH",
            body: JSON.stringify(fields),
        }));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        const r = data.result;
        return {
            content: [
                {
                    type: "text",
                    text: `✅ Updated ${r.type} "${r.name}" → ${r.content}`,
                },
            ],
        };
    });
    // ── cloudflare_delete_dns_record ──────────────────────────────────────────
    server.registerTool("cloudflare_delete_dns_record", {
        title: "Cloudflare — Delete DNS Record",
        description: `Delete a DNS record by ID. This is irreversible — list records first.`,
        inputSchema: z.object({
            record_id: z.string().describe("32-char hex record ID"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ record_id }) => {
        const data = (await cfFetch(`/dns_records/${record_id}`, {
            method: "DELETE",
        }));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        return {
            content: [{ type: "text", text: `✅ Deleted DNS record ${record_id}` }],
        };
    });
    // ── cloudflare_purge_cache ────────────────────────────────────────────────
    server.registerTool("cloudflare_purge_cache", {
        title: "Cloudflare — Purge Cache",
        description: `Purge Cloudflare edge cache for cloudless.gr.
Use purge_everything=true to wipe all cached assets (use after major deploys).
Or provide specific URLs to purge individual files.
Note: purge_everything counts against rate limit — don't run in loops.`,
        inputSchema: z.object({
            purge_everything: z
                .boolean()
                .default(false)
                .describe("Wipe entire zone cache"),
            files: z
                .array(z.string())
                .optional()
                .describe("Specific URLs to purge, e.g. ['https://cloudless.gr/index.html']"),
        }),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async ({ purge_everything, files }) => {
        const body = purge_everything ? { purge_everything: true } : { files };
        const data = (await cfFetch("/purge_cache", {
            method: "POST",
            body: JSON.stringify(body),
        }));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        const msg = purge_everything
            ? "✅ Entire cache purged for cloudless.gr"
            : `✅ Purged ${files?.length ?? 0} URL(s) from cache`;
        return { content: [{ type: "text", text: msg }] };
    });
    // ── cloudflare_zone_analytics ─────────────────────────────────────────────
    server.registerTool("cloudflare_zone_analytics", {
        title: "Cloudflare — Zone Analytics",
        description: `Get traffic analytics for cloudless.gr via Cloudflare GraphQL API.
Returns: requests, bandwidth, cached %, threats, unique visitors.
Default: last 24 hours. Requires Zone Analytics:Read on the token.`,
        inputSchema: z.object({
            since_hours: z
                .number()
                .int()
                .min(1)
                .max(168)
                .default(24)
                .describe("Hours to look back (1–168)"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ since_hours }) => {
        const now = new Date();
        const start = new Date(now.getTime() - since_hours * 60 * 60 * 1000);
        const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
        const query = `{
        viewer {
          zones(filter: { zoneTag: "${CLOUDFLARE_ZONE_ID}" }) {
            httpRequests1hGroups(
              limit: 168
              filter: { datetime_geq: "${fmt(start)}", datetime_lt: "${fmt(now)}" }
              orderBy: [datetime_ASC]
            ) {
              sum {
                requests
                cachedRequests
                bytes
                cachedBytes
                threats
                pageViews
              }
              uniq {
                uniques
              }
            }
          }
        }
      }`;
        const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ query }),
        });
        const data = (await res.json());
        if (data.errors?.length) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ GraphQL error: ${data.errors.map((e) => e.message).join(", ")}`,
                    },
                ],
            };
        }
        const groups = data.data?.viewer.zones[0]?.httpRequests1hGroups ?? [];
        if (!groups.length) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No analytics data for the last ${since_hours}h (zone may have no traffic yet).`,
                    },
                ],
            };
        }
        // Aggregate across all hourly buckets
        const totals = groups.reduce((acc, g) => ({
            requests: acc.requests + g.sum.requests,
            cachedRequests: acc.cachedRequests + g.sum.cachedRequests,
            bytes: acc.bytes + g.sum.bytes,
            cachedBytes: acc.cachedBytes + g.sum.cachedBytes,
            threats: acc.threats + g.sum.threats,
            pageViews: acc.pageViews + g.sum.pageViews,
            uniques: acc.uniques + g.uniq.uniques,
        }), {
            requests: 0,
            cachedRequests: 0,
            bytes: 0,
            cachedBytes: 0,
            threats: 0,
            pageViews: 0,
            uniques: 0,
        });
        const cachedPct = totals.requests > 0
            ? ((totals.cachedRequests / totals.requests) * 100).toFixed(1)
            : "0";
        const bwMb = (totals.bytes / 1024 / 1024).toFixed(2);
        const bwCachedMb = (totals.cachedBytes / 1024 / 1024).toFixed(2);
        const text = [
            `## cloudless.gr — last ${since_hours}h analytics (${groups.length} hourly buckets)`,
            ``,
            `Requests:   ${totals.requests.toLocaleString()} total  (${totals.cachedRequests.toLocaleString()} cached = ${cachedPct}%)`,
            `Bandwidth:  ${bwMb} MB total  (${bwCachedMb} MB cached)`,
            `Threats:    ${totals.threats.toLocaleString()}`,
            `Uniques:    ${totals.uniques.toLocaleString()}`,
            `Pageviews:  ${totals.pageViews.toLocaleString()}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
    });
    // ── cloudflare_zone_settings ──────────────────────────────────────────────
    server.registerTool("cloudflare_zone_settings", {
        title: "Cloudflare — Zone Settings",
        description: `Get key security and performance settings for cloudless.gr zone.
Shows: SSL mode, security level, min TLS version, HTTP/2, HTTP/3, HSTS, brotli, rocket loader.
Useful for diagnosing TLS issues, checking caching mode, or verifying security posture.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const KEYS = [
            "ssl",
            "security_level",
            "min_tls_version",
            "tls_1_3",
            "http2",
            "http3",
            "0rtt",
            "brotli",
            "always_use_https",
            "hsts",
            "rocket_loader",
            "cache_level",
            "development_mode",
        ];
        const results = [];
        for (const key of KEYS) {
            const data = (await cfFetch(`/settings/${key}`));
            if (data.success) {
                const val = typeof data.result.value === "object"
                    ? JSON.stringify(data.result.value)
                    : String(data.result.value);
                results.push(`${key.padEnd(22)}  ${val}`);
            }
        }
        return {
            content: [
                {
                    type: "text",
                    text: `## cloudless.gr zone settings\n\n${results.join("\n")}`,
                },
            ],
        };
    });
    // ── cloudflare_list_tokens ────────────────────────────────────────────────
    server.registerTool("cloudflare_list_tokens", {
        title: "Cloudflare — List API Tokens",
        description: `List all API tokens for the Cloudflare account.
Shows token ID, name, status, created date, and expiry.
Requires the CLOUDFLARE_API_TOKEN to have "User API Tokens:Read" permission.
Use this to audit tokens, find IDs for deletion, or check expiry.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const data = (await cfApiFetch("/user/tokens"));
        if (!data.success)
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ ${cfError(data)}\n\nNote: Requires "User API Tokens:Read" permission on the token.`,
                    },
                ],
            };
        if (!data.result.length)
            return { content: [{ type: "text", text: "No tokens found." }] };
        const rows = data.result.map((t) => [
            `ID:      ${t.id}`,
            `Name:    ${t.name}`,
            `Status:  ${t.status}`,
            `Created: ${t.issued_on}`,
            `Expires: ${t.expires_on ?? "never"}`,
            `Last use: ${t.last_used_on ?? "never"}`,
        ].join("\n"));
        return {
            content: [
                {
                    type: "text",
                    text: `## API Tokens (${data.result.length})\n\n${rows.join("\n\n---\n\n")}`,
                },
            ],
        };
    });
    // ── cloudflare_list_permission_groups ─────────────────────────────────────
    server.registerTool("cloudflare_list_permission_groups", {
        title: "Cloudflare — List Permission Groups",
        description: `List all available Cloudflare API token permission groups with their IDs.
Use this to find the correct permission_group IDs before calling cloudflare_create_token.
Filter by scope: "zone", "account", "user", or omit for all.`,
        inputSchema: z.object({
            filter: z
                .string()
                .optional()
                .describe('Optional text filter, e.g. "analytics" or "dns"'),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ filter }) => {
        const data = (await cfApiFetch("/user/tokens/permission_groups"));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        let groups = data.result;
        if (filter) {
            const f = filter.toLowerCase();
            groups = groups.filter((g) => g.name.toLowerCase().includes(f));
        }
        const rows = groups.map((g) => `${g.id}  ${g.name.padEnd(45)}  [${g.scopes.join(", ")}]`);
        return {
            content: [
                {
                    type: "text",
                    text: `## Permission Groups (${groups.length})\n\n${rows.join("\n")}`,
                },
            ],
        };
    });
    // ── cloudflare_create_token ───────────────────────────────────────────────
    server.registerTool("cloudflare_create_token", {
        title: "Cloudflare — Create API Token",
        description: `Create a new Cloudflare API token with specified permissions.
Requires CLOUDFLARE_API_TOKEN to have "User API Tokens:Edit" permission.

WORKFLOW:
1. Run cloudflare_list_permission_groups to find permission group IDs
2. Build policies array with resources + permission_groups
3. Call this tool

EXAMPLE policies for a Zone Analytics:Read token:
[{
  "effect": "allow",
  "resources": { "com.cloudflare.api.account.zone.aa875388a91714c369b1e20107e643f5": "*" },
  "permission_groups": [{ "id": "<id-from-list-groups>", "name": "Zone Analytics Read" }]
}]

Zone resource key format: "com.cloudflare.api.account.zone.<ZONE_ID>"
Account resource: "com.cloudflare.api.account.<ACCOUNT_ID>"`,
        inputSchema: z.object({
            name: z.string().describe("Token name, e.g. 'cloudflare-geo-exporter'"),
            policies: z
                .array(z.object({
                effect: z.enum(["allow", "deny"]).default("allow"),
                resources: z.record(z.string()),
                permission_groups: z.array(z.object({ id: z.string(), name: z.string().optional() })),
            }))
                .describe("Array of policy objects"),
            expires_on: z
                .string()
                .optional()
                .describe("ISO 8601 expiry, e.g. '2027-01-01T00:00:00Z'"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ name, policies, expires_on }) => {
        const body = { name, policies };
        if (expires_on)
            body.expires_on = expires_on;
        const data = (await cfApiFetch("/user/tokens", {
            method: "POST",
            body: JSON.stringify(body),
        }));
        if (!data.success)
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ ${cfError(data)}\n\nNote: Requires "User API Tokens:Edit" permission.`,
                    },
                ],
            };
        const r = data.result;
        const lines = [
            `✅ Token created successfully`,
            `Name:   ${r.name}`,
            `ID:     ${r.id}`,
            `Status: ${r.status}`,
            r.value
                ? `\n⚠️  Token value (save this — shown only once):\n${r.value}`
                : "",
        ];
        return {
            content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
        };
    });
    // ── cloudflare_delete_token ───────────────────────────────────────────────
    server.registerTool("cloudflare_delete_token", {
        title: "Cloudflare — Delete API Token",
        description: `Delete a Cloudflare API token by ID. This is irreversible.
Use cloudflare_list_tokens to find the token ID first.
Requires "User API Tokens:Edit" permission.`,
        inputSchema: z.object({
            token_id: z.string().describe("Token ID from cloudflare_list_tokens"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ token_id }) => {
        const data = (await cfApiFetch(`/user/tokens/${token_id}`, {
            method: "DELETE",
        }));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        return {
            content: [{ type: "text", text: `✅ Deleted token ${token_id}` }],
        };
    });
    // ── cloudflare_worker_routes ──────────────────────────────────────────────
    server.registerTool("cloudflare_worker_routes", {
        title: "Cloudflare — Worker Routes",
        description: `List all Worker routes for cloudless.gr.
Shows which URL patterns are handled by which Worker scripts.
Useful for verifying cloudless-edge Worker is wired to the correct paths.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const data = (await cfFetch("/workers/routes"));
        if (!data.success)
            return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
            return {
                content: [{ type: "text", text: "No Worker routes configured." }],
            };
        const rows = data.result.map((r) => `${r.id}  ${r.pattern.padEnd(50)}  → ${r.script ?? "(none)"}`);
        return {
            content: [
                {
                    type: "text",
                    text: `## Worker Routes (${data.result.length})\n\n${rows.join("\n")}`,
                },
            ],
        };
    });
    // ── cloudflare_tunnel_status ──────────────────────────────────────────────
    server.registerTool("cloudflare_tunnel_status", {
        title: "Cloudflare Tunnel Status",
        description: `Check cloudflared tunnel service on omv-main.
Tunnel: cloudless-tunnel (ID: a82f24a8-f767-4a59-bc77-1d59ad132be2)
Returns systemd status + recent log lines + active connections.`,
        inputSchema: z.object({
            tail: z.number().int().min(5).max(100).default(30),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ tail }) => {
        const cmd = `echo '=== cloudflared service ===' && systemctl status cloudflared --no-pager -l` +
            ` && echo '=== Recent logs ===' && journalctl -u cloudflared -n ${tail} --no-pager` +
            ` && echo '=== Active connections ===' && journalctl -u cloudflared --since "5 minutes ago" --no-pager | grep -E 'Registered|connection|ERR|err' | tail -10 || true`;
        const r = await runOnNode("omv-main", cmd);
        const text = r.error
            ? `❌ SSH error: ${r.error}`
            : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── cloudflare_check_certs ────────────────────────────────────────────────
    server.registerTool("cloudflare_check_certs", {
        title: "K3s TLS Certificates Status",
        description: `Check cert-manager Certificate resources in K3s.
Shows all certs across all namespaces: Ready state, expiry, issuer.
Current certs: cloudless-online-tls, auth-cloudless-online-tls.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const KUBECTL = "sudo k3s kubectl";
        const cmd = `echo '=== Certificates ===' && ${KUBECTL} get certificates -A -o wide` +
            ` && echo '=== Certificate Requests ===' && ${KUBECTL} get certificaterequests -A` +
            ` && echo '=== Orders ===' && ${KUBECTL} get orders -A 2>/dev/null || true` +
            ` && echo '=== cert-manager logs (last 20) ===' && ${KUBECTL} logs -n cert-manager -l app=cert-manager --tail=20 2>&1`;
        const r = await runOnNode("omv-main", cmd);
        const text = r.error
            ? `❌ SSH error: ${r.error}`
            : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── cloudflare_restart_tunnel ─────────────────────────────────────────────
    server.registerTool("cloudflare_restart_tunnel", {
        title: "Restart Cloudflare Tunnel",
        description: `Restart cloudflared on omv-main. Use when tunnel is stuck or connections drop.`,
        inputSchema: z.object({}),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async () => {
        const cmd = `sudo systemctl restart cloudflared && sleep 3 && systemctl is-active cloudflared`;
        const r = await runOnNode("omv-main", cmd);
        const text = r.error
            ? `❌ SSH error: ${r.error}`
            : r.stdout.trim() === "active"
                ? "✅ cloudflared restarted and is active"
                : "⚠️ Restarted but status: " + r.stdout.trim();
        return { content: [{ type: "text", text }] };
    });
}
//# sourceMappingURL=cloudflare.js.map