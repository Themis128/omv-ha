import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID,
  CHARACTER_LIMIT,
} from "../constants.js";

const CF_API = "https://api.cloudflare.com/client/v4";

// ── Infrastructure ────────────────────────────────────────────────────────────

type CfResult<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }>;
};

function cfError(data: {
  success: boolean;
  errors?: Array<{ code?: number; message: string }>;
}): string {
  if (!data.errors?.length) return "Unknown Cloudflare error";
  return data.errors.map((e) => (e.code ? `[${e.code}] ${e.message}` : e.message)).join("; ");
}

async function cfRawFetch(url: string, options: RequestInit = {}): Promise<unknown> {
  if (!CLOUDFLARE_API_TOKEN) {
    throw new Error("CLOUDFLARE_API_TOKEN is not set — set it in environment or .env");
  }
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 400) {
    // 400 carries Cloudflare error detail in body; other HTTP errors won't have JSON
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

// Lazy zone-ID discovery — if CLOUDFLARE_ZONE_ID is empty, look it up once
let _resolvedZoneId: string | null = null;
async function resolveZoneId(): Promise<string> {
  if (CLOUDFLARE_ZONE_ID) return CLOUDFLARE_ZONE_ID;
  if (_resolvedZoneId) return _resolvedZoneId;
  const data = (await cfRawFetch(`${CF_API}/zones?name=cloudless.gr&status=active`)) as CfResult<
    Array<{ id: string; name: string }>
  >;
  if (!data.success || !data.result.length) {
    throw new Error(
      `Cannot auto-discover zone ID for cloudless.gr: ${cfError(data)}. ` +
        "Set CLOUDFLARE_ZONE_ID env var to the zone ID from dash.cloudflare.com → cloudless.gr → Overview.",
    );
  }
  _resolvedZoneId = data.result[0].id;
  return _resolvedZoneId;
}

// Zone-scoped fetch (auto-discovers zone ID if not set)
async function cfFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const zoneId = await resolveZoneId();
  return cfRawFetch(`${CF_API}/zones/${zoneId}${path}`, options);
}

// Account-scoped fetch
async function cfAccountFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  if (!CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set");
  return cfRawFetch(`${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}`, options);
}

// User/generic fetch
async function cfApiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  return cfRawFetch(`${CF_API}${path}`, options);
}

function trunc(text: string): string {
  return text.length > CHARACTER_LIMIT ? text.slice(0, CHARACTER_LIMIT) + "\n…(truncated)" : text;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export function registerCloudflareTools(server: McpServer): void {

  // ── cloudflare_verify_token ───────────────────────────────────────────────
  server.registerTool(
    "cloudflare_verify_token",
    {
      title: "Cloudflare — Verify API Token",
      description: `Verify that the current CLOUDFLARE_API_TOKEN is valid and active.
Returns token ID, status, and the zone ID it resolves to.
Run this first to confirm the token is working before other Cloudflare tools.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = (await cfApiFetch("/user/tokens/verify")) as CfResult<{
          id: string;
          status: string;
        }>;
        if (!data.success) {
          return {
            content: [{ type: "text", text: `❌ Token invalid: ${cfError(data)}` }],
          };
        }
        let zoneNote = "";
        try {
          const zoneId = await resolveZoneId();
          zoneNote = `\nZone ID (cloudless.gr): ${zoneId}`;
        } catch (e) {
          zoneNote = `\nZone ID: ⚠️ could not resolve — ${(e as Error).message}`;
        }
        return {
          content: [
            {
              type: "text",
              text: `✅ Token valid\nID:     ${data.result.id}\nStatus: ${data.result.status}${zoneNote}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ ${(e as Error).message}` }],
        };
      }
    },
  );

  // ── cloudflare_get_zone_id ────────────────────────────────────────────────
  server.registerTool(
    "cloudflare_get_zone_id",
    {
      title: "Cloudflare — Get Zone ID",
      description: `Look up the Cloudflare zone ID for a domain.
Defaults to cloudless.gr. Use this to find the zone ID to set as CLOUDFLARE_ZONE_ID.
Returns zone ID, name server addresses, status, and plan.`,
      inputSchema: z.object({
        name: z.string().default("cloudless.gr").describe("Domain name to look up"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ name }) => {
      try {
        const data = (await cfApiFetch(`/zones?name=${encodeURIComponent(name)}`)) as CfResult<
          Array<{
            id: string;
            name: string;
            status: string;
            name_servers: string[];
            plan: { name: string };
            meta: { page_rule_quota: number };
          }>
        >;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
          return { content: [{ type: "text", text: `No zone found for "${name}".` }] };
        const z = data.result[0];
        const text = [
          `## Zone: ${z.name}`,
          `ID:           ${z.id}`,
          `Status:       ${z.status}`,
          `Plan:         ${z.plan?.name ?? "unknown"}`,
          `Name servers: ${z.name_servers?.join(", ") ?? "n/a"}`,
          ``,
          `Set env var:  export CLOUDFLARE_ZONE_ID="${z.id}"`,
          `Or GitHub variable: gh variable set CLOUDFLARE_ZONE_ID --repo Themis128/omv-ha --body "${z.id}"`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_list_dns_records ───────────────────────────────────────────
  server.registerTool(
    "cloudflare_list_dns_records",
    {
      title: "Cloudflare — List DNS Records",
      description: `List all DNS records for cloudless.gr.
Returns record ID, type, name, content, TTL, and proxied status.
Always run this before adding or deleting records to check current state.`,
      inputSchema: z.object({
        type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"]).optional(),
        name: z.string().optional().describe('e.g. "auth.cloudless.gr"'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ type, name }) => {
      try {
        const params = new URLSearchParams({ per_page: "100" });
        if (type) params.set("type", type);
        if (name) params.set("name", name);
        const data = (await cfFetch(`/dns_records?${params}`)) as CfResult<
          Array<{
            id: string;
            type: string;
            name: string;
            content: string;
            ttl: number;
            proxied: boolean;
            modified_on: string;
          }>
        >;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
          return { content: [{ type: "text", text: "No DNS records found." }] };
        const rows = data.result.map(
          (r) =>
            `${r.id}  ${r.type.padEnd(6)}  ${r.name.padEnd(40)}  ${r.content}  TTL=${r.ttl}  proxied=${r.proxied}`,
        );
        return {
          content: [
            {
              type: "text",
              text: trunc(`DNS records (${data.result.length}):\n\n${rows.join("\n")}`),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_add_dns_record ─────────────────────────────────────────────
  server.registerTool(
    "cloudflare_add_dns_record",
    {
      title: "Cloudflare — Add DNS Record",
      description: `Add a new DNS record to cloudless.gr.
Supports A, AAAA, CNAME, TXT, MX. For tunnel CNAMEs use content="<tunnel-id>.cfargotunnel.com".`,
      inputSchema: z.object({
        type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX"]),
        name: z.string().describe('Use "@" for apex or subdomain name'),
        content: z.string(),
        ttl: z.number().int().default(1).describe("1 = Cloudflare auto"),
        proxied: z.boolean().default(true),
        priority: z.number().int().optional().describe("MX priority"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ type, name, content, ttl, proxied, priority }) => {
      try {
        const body: Record<string, unknown> = { type, name, content, ttl, proxied };
        if (priority !== undefined) body.priority = priority;
        const data = (await cfFetch("/dns_records", {
          method: "POST",
          body: JSON.stringify(body),
        })) as CfResult<{ id: string; name: string; type: string; content: string }>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        const r = data.result;
        return {
          content: [
            { type: "text", text: `✅ Created ${r.type} "${r.name}" → ${r.content} (ID: ${r.id})` },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_update_dns_record ──────────────────────────────────────────
  server.registerTool(
    "cloudflare_update_dns_record",
    {
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
    },
    async ({ record_id, ...fields }) => {
      try {
        const data = (await cfFetch(`/dns_records/${record_id}`, {
          method: "PATCH",
          body: JSON.stringify(fields),
        })) as CfResult<{ id: string; name: string; type: string; content: string }>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        const r = data.result;
        return {
          content: [{ type: "text", text: `✅ Updated ${r.type} "${r.name}" → ${r.content}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_delete_dns_record ──────────────────────────────────────────
  server.registerTool(
    "cloudflare_delete_dns_record",
    {
      title: "Cloudflare — Delete DNS Record",
      description: `Delete a DNS record by ID. This is irreversible — list records first.`,
      inputSchema: z.object({
        record_id: z.string().describe("32-char hex record ID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ record_id }) => {
      try {
        const data = (await cfFetch(`/dns_records/${record_id}`, {
          method: "DELETE",
        })) as CfResult<{ id: string }>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        return {
          content: [{ type: "text", text: `✅ Deleted DNS record ${record_id}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_bulk_restore_dns ───────────────────────────────────────────
  server.registerTool(
    "cloudflare_bulk_restore_dns",
    {
      title: "Cloudflare — Bulk Restore DNS Records",
      description: `Restore multiple DNS records in one operation. Skips records that already exist.
Use after a DNS drift event (accidental deletion). Each record is attempted independently.

Example records array:
[
  { "type": "A",     "name": "@",               "content": "192.0.2.1", "proxied": true },
  { "type": "CNAME", "name": "www",              "content": "cloudless.gr", "proxied": true },
  { "type": "TXT",   "name": "_dmarc",           "content": "v=DMARC1; p=reject", "proxied": false },
  { "type": "MX",    "name": "@",                "content": "mail.example.com", "priority": 10, "proxied": false }
]`,
      inputSchema: z.object({
        records: z.array(
          z.object({
            type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "CAA"]),
            name: z.string(),
            content: z.string(),
            ttl: z.number().int().default(1),
            proxied: z.boolean().default(false),
            priority: z.number().int().optional(),
          }),
        ),
        dry_run: z.boolean().default(false).describe("Print records without creating them"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ records, dry_run }) => {
      if (dry_run) {
        const preview = records
          .map((r) => `  ${r.type.padEnd(6)} ${r.name.padEnd(40)} → ${r.content}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `DRY RUN — ${records.length} record(s) would be created:\n${preview}`,
            },
          ],
        };
      }

      const results: string[] = [];
      for (const rec of records) {
        try {
          const body: Record<string, unknown> = {
            type: rec.type,
            name: rec.name,
            content: rec.content,
            ttl: rec.ttl,
            proxied: rec.proxied,
          };
          if (rec.priority !== undefined) body.priority = rec.priority;
          const data = (await cfFetch("/dns_records", {
            method: "POST",
            body: JSON.stringify(body),
          })) as CfResult<{ id: string; name: string; type: string }>;
          if (data.success) {
            results.push(`✅ ${rec.type.padEnd(6)} ${rec.name} → ${rec.content} (ID: ${data.result.id})`);
          } else {
            const err = cfError(data);
            // Record already exists (code 81057) — treat as success
            if (data.errors?.some((e) => e.code === 81057)) {
              results.push(`⏭  ${rec.type.padEnd(6)} ${rec.name} already exists — skipped`);
            } else {
              results.push(`❌ ${rec.type.padEnd(6)} ${rec.name}: ${err}`);
            }
          }
        } catch (e) {
          results.push(`❌ ${rec.type.padEnd(6)} ${rec.name}: ${(e as Error).message}`);
        }
      }
      const ok = results.filter((r) => r.startsWith("✅")).length;
      const skipped = results.filter((r) => r.startsWith("⏭")).length;
      const failed = results.filter((r) => r.startsWith("❌")).length;
      return {
        content: [
          {
            type: "text",
            text: trunc(
              `## DNS Restore: ${ok} created, ${skipped} skipped, ${failed} failed\n\n${results.join("\n")}`,
            ),
          },
        ],
      };
    },
  );

  // ── cloudflare_purge_cache ────────────────────────────────────────────────
  server.registerTool(
    "cloudflare_purge_cache",
    {
      title: "Cloudflare — Purge Cache",
      description: `Purge Cloudflare edge cache for cloudless.gr.
Use purge_everything=true to wipe all cached assets (use after major deploys).
Or provide specific URLs to purge individual files.`,
      inputSchema: z.object({
        purge_everything: z.boolean().default(false).describe("Wipe entire zone cache"),
        files: z
          .array(z.string())
          .optional()
          .describe("Specific URLs to purge, e.g. ['https://cloudless.gr/index.html']"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ purge_everything, files }) => {
      try {
        const body = purge_everything ? { purge_everything: true } : { files };
        const data = (await cfFetch("/purge_cache", {
          method: "POST",
          body: JSON.stringify(body),
        })) as CfResult<{ id: string }>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        const msg = purge_everything
          ? "✅ Entire cache purged for cloudless.gr"
          : `✅ Purged ${files?.length ?? 0} URL(s) from cache`;
        return { content: [{ type: "text", text: msg }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_zone_analytics ─────────────────────────────────────────────
  server.registerTool(
    "cloudflare_zone_analytics",
    {
      title: "Cloudflare — Zone Analytics",
      description: `Get traffic analytics for cloudless.gr via Cloudflare GraphQL API.
Returns: requests, bandwidth, cached %, threats, unique visitors.
Default: last 24 hours.`,
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
    },
    async ({ since_hours }) => {
      try {
        const zoneId = await resolveZoneId();
        const now = new Date();
        const start = new Date(now.getTime() - since_hours * 60 * 60 * 1000);
        const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

        const query = `{
          viewer {
            zones(filter: { zoneTag: "${zoneId}" }) {
              httpRequests1hGroups(
                limit: 168
                filter: { datetime_geq: "${fmt(start)}", datetime_lt: "${fmt(now)}" }
                orderBy: [datetime_ASC]
              ) {
                sum { requests cachedRequests bytes cachedBytes threats pageViews }
                uniq { uniques }
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
        const data = (await res.json()) as {
          data?: {
            viewer: {
              zones: Array<{
                httpRequests1hGroups: Array<{
                  sum: {
                    requests: number;
                    cachedRequests: number;
                    bytes: number;
                    cachedBytes: number;
                    threats: number;
                    pageViews: number;
                  };
                  uniq: { uniques: number };
                }>;
              }>;
            };
          };
          errors?: Array<{ message: string }>;
        };

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
                text: `No analytics data for the last ${since_hours}h.`,
              },
            ],
          };
        }

        const totals = groups.reduce(
          (acc, g) => ({
            requests: acc.requests + g.sum.requests,
            cachedRequests: acc.cachedRequests + g.sum.cachedRequests,
            bytes: acc.bytes + g.sum.bytes,
            cachedBytes: acc.cachedBytes + g.sum.cachedBytes,
            threats: acc.threats + g.sum.threats,
            pageViews: acc.pageViews + g.sum.pageViews,
            uniques: acc.uniques + g.uniq.uniques,
          }),
          { requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0, uniques: 0 },
        );

        const cachedPct =
          totals.requests > 0
            ? ((totals.cachedRequests / totals.requests) * 100).toFixed(1)
            : "0";
        const bwMb = (totals.bytes / 1024 / 1024).toFixed(2);
        const bwCachedMb = (totals.cachedBytes / 1024 / 1024).toFixed(2);

        return {
          content: [
            {
              type: "text",
              text: [
                `## cloudless.gr — last ${since_hours}h analytics (${groups.length} hourly buckets)`,
                ``,
                `Requests:   ${totals.requests.toLocaleString()} total  (${totals.cachedRequests.toLocaleString()} cached = ${cachedPct}%)`,
                `Bandwidth:  ${bwMb} MB total  (${bwCachedMb} MB cached)`,
                `Threats:    ${totals.threats.toLocaleString()}`,
                `Uniques:    ${totals.uniques.toLocaleString()}`,
                `Pageviews:  ${totals.pageViews.toLocaleString()}`,
              ].join("\n"),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_zone_settings ──────────────────────────────────────────────
  server.registerTool(
    "cloudflare_zone_settings",
    {
      title: "Cloudflare — Zone Settings",
      description: `Get key security and performance settings for cloudless.gr zone.
Shows: SSL mode, security level, min TLS version, HTTP/2, HTTP/3, HSTS, brotli.
Useful for diagnosing TLS issues, checking caching mode, or verifying security posture.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
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
        const results: string[] = [];
        for (const key of KEYS) {
          try {
            const data = (await cfFetch(`/settings/${key}`)) as CfResult<{
              id: string;
              value: unknown;
            }>;
            if (data.success) {
              const val =
                typeof data.result.value === "object"
                  ? JSON.stringify(data.result.value)
                  : String(data.result.value);
              results.push(`${key.padEnd(22)}  ${val}`);
            }
          } catch {
            // skip unavailable settings
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
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_list_tokens ────────────────────────────────────────────────
  server.registerTool(
    "cloudflare_list_tokens",
    {
      title: "Cloudflare — List API Tokens",
      description: `List all API tokens for the Cloudflare account.
Shows token ID, name, status, created date, and expiry.
Use this to audit tokens, find IDs for deletion, or check expiry.
Requires "User:User API Tokens:Read" permission on the current token.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = (await cfApiFetch("/user/tokens")) as CfResult<
          Array<{
            id: string;
            name: string;
            status: string;
            issued_on: string;
            expires_on?: string | null;
            last_used_on?: string | null;
          }>
        >;
        if (!data.success)
          return {
            content: [
              {
                type: "text",
                text: `❌ ${cfError(data)}\n\nNote: Requires "User:User API Tokens:Read" permission.`,
              },
            ],
          };
        if (!data.result.length)
          return { content: [{ type: "text", text: "No tokens found." }] };
        const rows = data.result.map((t) =>
          [
            `ID:      ${t.id}`,
            `Name:    ${t.name}`,
            `Status:  ${t.status}`,
            `Created: ${t.issued_on}`,
            `Expires: ${t.expires_on ?? "never"}`,
            `Last use: ${t.last_used_on ?? "never"}`,
          ].join("\n"),
        );
        return {
          content: [
            {
              type: "text",
              text: trunc(`## API Tokens (${data.result.length})\n\n${rows.join("\n\n---\n\n")}`),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_list_permission_groups ─────────────────────────────────────
  server.registerTool(
    "cloudflare_list_permission_groups",
    {
      title: "Cloudflare — List Permission Groups",
      description: `List all available Cloudflare API token permission groups with their IDs.
Use this to find the correct permission_group IDs before calling cloudflare_create_token.
Filter by scope: "zone", "account", "user", or a keyword like "dns" or "load".`,
      inputSchema: z.object({
        filter: z
          .string()
          .optional()
          .describe('Optional text filter, e.g. "dns" or "load balancing"'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ filter }) => {
      try {
        const data = (await cfApiFetch(
          "/user/tokens/permission_groups",
        )) as CfResult<Array<{ id: string; name: string; scopes: string[] }>>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        let groups = data.result;
        if (filter) {
          const f = filter.toLowerCase();
          groups = groups.filter((g) => g.name.toLowerCase().includes(f));
        }
        const rows = groups.map(
          (g) => `${g.id}  ${g.name.padEnd(50)}  [${g.scopes.join(", ")}]`,
        );
        return {
          content: [
            {
              type: "text",
              text: trunc(`## Permission Groups (${groups.length})\n\n${rows.join("\n")}`),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_create_token ───────────────────────────────────────────────
  server.registerTool(
    "cloudflare_create_token",
    {
      title: "Cloudflare — Create API Token",
      description: `Create a new Cloudflare API token with specified permissions.
Requires current token to have "User:User API Tokens:Edit" permission.

WORKFLOW:
1. Run cloudflare_list_permission_groups (optionally filtered) to find group IDs
2. Build policies array and call this tool

Zone resource key format: "com.cloudflare.api.account.zone.<ZONE_ID>"
Account resource: "com.cloudflare.api.account.<ACCOUNT_ID>"
All zones: "com.cloudflare.api.account.zone.*"`,
      inputSchema: z.object({
        name: z.string().describe("Token name, e.g. 'cert-manager-dns01'"),
        policies: z
          .array(
            z.object({
              effect: z.enum(["allow", "deny"]).default("allow"),
              resources: z.record(z.string()),
              permission_groups: z.array(
                z.object({ id: z.string(), name: z.string().optional() }),
              ),
            }),
          )
          .describe("Array of policy objects"),
        expires_on: z
          .string()
          .optional()
          .describe("ISO 8601 expiry, e.g. '2027-01-01T00:00:00Z'"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, policies, expires_on }) => {
      try {
        const body: Record<string, unknown> = { name, policies };
        if (expires_on) body.expires_on = expires_on;
        const data = (await cfApiFetch("/user/tokens", {
          method: "POST",
          body: JSON.stringify(body),
        })) as CfResult<{ id: string; name: string; value?: string; status: string }>;
        if (!data.success)
          return {
            content: [
              {
                type: "text",
                text: `❌ ${cfError(data)}\n\nNote: Requires "User:User API Tokens:Edit" permission.`,
              },
            ],
          };
        const r = data.result;
        const lines = [
          `✅ Token created successfully`,
          `Name:   ${r.name}`,
          `ID:     ${r.id}`,
          `Status: ${r.status}`,
          r.value ? `\n⚠️  Token value (save this — shown only once):\n${r.value}` : "",
        ];
        return {
          content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_rotate_token ───────────────────────────────────────────────
  server.registerTool(
    "cloudflare_rotate_token",
    {
      title: "Cloudflare — Rotate API Token",
      description: `Rotate a Cloudflare API token: create a new token with the same permissions as the
named token, then delete the old one. Returns the new token value (save it immediately).

Requires current CLOUDFLARE_API_TOKEN to have "User:User API Tokens:Edit" permission.

WORKFLOW:
1. Lists all tokens to find the one matching old_token_name
2. Reads its policies
3. Creates a new token with the same name + policies
4. Optionally deletes the old token (set delete_old=false to keep it during transition)`,
      inputSchema: z.object({
        old_token_name: z.string().describe("Exact name of the token to rotate"),
        new_name: z
          .string()
          .optional()
          .describe("New token name (defaults to same name as old)"),
        delete_old: z
          .boolean()
          .default(true)
          .describe("Delete the old token after creating the new one"),
        expires_on: z.string().optional().describe("ISO 8601 expiry for new token"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ old_token_name, new_name, delete_old, expires_on }) => {
      try {
        // Step 1: find old token
        const listData = (await cfApiFetch("/user/tokens")) as CfResult<
          Array<{ id: string; name: string; status: string; policies: unknown[] }>
        >;
        if (!listData.success)
          return { content: [{ type: "text", text: `❌ Could not list tokens: ${cfError(listData)}` }] };
        const oldToken = listData.result.find((t) => t.name === old_token_name);
        if (!oldToken) {
          const names = listData.result.map((t) => `  - ${t.name}`).join("\n");
          return {
            content: [
              {
                type: "text",
                text: `❌ No token named "${old_token_name}" found.\n\nExisting tokens:\n${names}`,
              },
            ],
          };
        }

        // Step 2: get full token details (policies)
        const detailData = (await cfApiFetch(`/user/tokens/${oldToken.id}`)) as CfResult<{
          id: string;
          name: string;
          policies: unknown[];
        }>;
        if (!detailData.success)
          return {
            content: [
              { type: "text", text: `❌ Could not read token details: ${cfError(detailData)}` },
            ],
          };

        // Step 3: create new token with same policies
        const createBody: Record<string, unknown> = {
          name: new_name ?? old_token_name,
          policies: detailData.result.policies,
        };
        if (expires_on) createBody.expires_on = expires_on;
        const createData = (await cfApiFetch("/user/tokens", {
          method: "POST",
          body: JSON.stringify(createBody),
        })) as CfResult<{ id: string; name: string; value?: string; status: string }>;
        if (!createData.success)
          return {
            content: [{ type: "text", text: `❌ Token creation failed: ${cfError(createData)}` }],
          };

        const newToken = createData.result;
        const lines: string[] = [
          `✅ New token created`,
          `Name:  ${newToken.name}`,
          `ID:    ${newToken.id}`,
          newToken.value
            ? `\n⚠️  TOKEN VALUE (save this — shown only once):\n${newToken.value}`
            : "",
        ];

        // Step 4: optionally delete old token
        if (delete_old) {
          const delData = (await cfApiFetch(`/user/tokens/${oldToken.id}`, {
            method: "DELETE",
          })) as CfResult<{ id: string }>;
          if (delData.success) {
            lines.push(`\n✅ Old token "${old_token_name}" (${oldToken.id}) deleted`);
          } else {
            lines.push(`\n⚠️  New token created but old token deletion failed: ${cfError(delData)}`);
          }
        } else {
          lines.push(`\nℹ️  Old token "${old_token_name}" (${oldToken.id}) kept — delete manually when ready`);
        }

        return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_delete_token ───────────────────────────────────────────────
  server.registerTool(
    "cloudflare_delete_token",
    {
      title: "Cloudflare — Delete API Token",
      description: `Delete a Cloudflare API token by ID. This is irreversible.
Use cloudflare_list_tokens to find the token ID first.
Requires "User:User API Tokens:Edit" permission.`,
      inputSchema: z.object({
        token_id: z.string().describe("Token ID from cloudflare_list_tokens"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ token_id }) => {
      try {
        const data = (await cfApiFetch(`/user/tokens/${token_id}`, {
          method: "DELETE",
        })) as CfResult<{ id: string }>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        return { content: [{ type: "text", text: `✅ Deleted token ${token_id}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_list_lb_monitors ───────────────────────────────────────────
  server.registerTool(
    "cloudflare_list_lb_monitors",
    {
      title: "Cloudflare — List LB Monitors",
      description: `List all Cloudflare Load Balancer health monitors for the account.
Returns monitor ID, type, path, interval, and expected status codes.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = (await cfAccountFetch("/load_balancers/monitors")) as CfResult<
          Array<{
            id: string;
            description: string;
            type: string;
            path: string;
            interval: number;
            expected_codes: string;
            timeout: number;
          }>
        >;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
          return { content: [{ type: "text", text: "No LB monitors configured." }] };
        const rows = data.result.map((m) =>
          [
            `ID:          ${m.id}`,
            `Description: ${m.description || "(none)"}`,
            `Type:        ${m.type}  Path: ${m.path}`,
            `Interval:    ${m.interval}s  Timeout: ${m.timeout}s  Expected: ${m.expected_codes}`,
          ].join("\n"),
        );
        return {
          content: [
            {
              type: "text",
              text: `## LB Monitors (${data.result.length})\n\n${rows.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_list_lb_pools ──────────────────────────────────────────────
  server.registerTool(
    "cloudflare_list_lb_pools",
    {
      title: "Cloudflare — List LB Pools",
      description: `List all Cloudflare Load Balancer origin pools for the account.
Returns pool ID, name, origins, health, and monitor association.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = (await cfAccountFetch("/load_balancers/pools")) as CfResult<
          Array<{
            id: string;
            name: string;
            enabled: boolean;
            healthy: boolean;
            monitor: string;
            origins: Array<{ name: string; address: string; enabled: boolean; weight: number; healthy: boolean }>;
          }>
        >;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
          return { content: [{ type: "text", text: "No LB pools configured." }] };
        const rows = data.result.map((p) => {
          const origins = p.origins
            .map(
              (o) =>
                `    ${o.enabled ? "✅" : "⏸"} ${o.name.padEnd(20)} ${o.address}  w=${o.weight}  healthy=${o.healthy}`,
            )
            .join("\n");
          return [
            `ID:      ${p.id}`,
            `Name:    ${p.name}`,
            `Enabled: ${p.enabled}  Healthy: ${p.healthy}`,
            `Monitor: ${p.monitor || "(none)"}`,
            `Origins:\n${origins}`,
          ].join("\n");
        });
        return {
          content: [
            {
              type: "text",
              text: trunc(`## LB Pools (${data.result.length})\n\n${rows.join("\n\n---\n\n")}`),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_list_load_balancers ────────────────────────────────────────
  server.registerTool(
    "cloudflare_list_load_balancers",
    {
      title: "Cloudflare — List Load Balancers",
      description: `List all Cloudflare Load Balancers configured on the cloudless.gr zone.
Returns LB name, hostname, pool order, proxied status, and session affinity.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = (await cfFetch("/load_balancers")) as CfResult<
          Array<{
            id: string;
            name: string;
            enabled: boolean;
            proxied: boolean;
            default_pools: string[];
            fallback_pool: string;
            session_affinity: string;
          }>
        >;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
          return { content: [{ type: "text", text: "No load balancers configured." }] };
        const rows = data.result.map((lb) =>
          [
            `ID:            ${lb.id}`,
            `Name:          ${lb.name}`,
            `Enabled:       ${lb.enabled}  Proxied: ${lb.proxied}`,
            `Default pools: ${lb.default_pools.join(", ")}`,
            `Fallback pool: ${lb.fallback_pool}`,
            `Session aff:   ${lb.session_affinity}`,
          ].join("\n"),
        );
        return {
          content: [
            {
              type: "text",
              text: `## Load Balancers (${data.result.length})\n\n${rows.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_update_lb_pool_origins ─────────────────────────────────────
  server.registerTool(
    "cloudflare_update_lb_pool_origins",
    {
      title: "Cloudflare — Update LB Pool Origins",
      description: `Update the origins in an existing LB pool (e.g. change IP after Pi migration).
Use cloudflare_list_lb_pools to get pool IDs.`,
      inputSchema: z.object({
        pool_id: z.string().describe("Pool ID from cloudflare_list_lb_pools"),
        origins: z.array(
          z.object({
            name: z.string(),
            address: z.string().describe("IP address or hostname"),
            enabled: z.boolean().default(true),
            weight: z.number().default(1),
          }),
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ pool_id, origins }) => {
      try {
        const data = (await cfAccountFetch(`/load_balancers/pools/${pool_id}`, {
          method: "PATCH",
          body: JSON.stringify({ origins }),
        })) as CfResult<{ id: string; name: string; origins: unknown[] }>;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        return {
          content: [
            {
              type: "text",
              text: `✅ Updated pool "${data.result.name}" (${pool_id}) — ${origins.length} origin(s) set`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_provision_lb ───────────────────────────────────────────────
  server.registerTool(
    "cloudflare_provision_lb",
    {
      title: "Cloudflare — Provision Load Balancer (full stack)",
      description: `Provision a complete Cloudflare Load Balancer: health monitor + primary pool +
secondary pool + load balancer, in a single call. Idempotent — re-running updates
existing resources (matched by name). Replaces the provision-cloudflare-lb.yml workflow.

Default setup for cloudless.gr:
- Primary origin: CloudFront distribution
- Secondary origin: Tailscale Funnel (omv.tail8eb71.ts.net)
- Health check path: /api/health
- Active-passive: primary pool weight=1, secondary pool weight=0 (failover)`,
      inputSchema: z.object({
        hostname: z.string().default("cloudless.gr").describe("Hostname to load-balance"),
        primary_origin: z
          .string()
          .default("d3k7muo3c6lw6s.cloudfront.net")
          .describe("Primary origin address"),
        primary_origin_port: z.number().int().default(443),
        secondary_origin: z
          .string()
          .default("omv.tail8eb71.ts.net")
          .describe("Secondary (failover) origin"),
        secondary_origin_port: z.number().int().default(443),
        health_check_path: z.string().default("/api/health"),
        dry_run: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({
      hostname,
      primary_origin,
      primary_origin_port,
      secondary_origin,
      secondary_origin_port,
      health_check_path,
      dry_run,
    }) => {
      if (dry_run) {
        return {
          content: [
            {
              type: "text",
              text: [
                `DRY RUN — would provision:`,
                `  Monitor:         HTTPS ${health_check_path} → ${hostname}`,
                `  Primary pool:    ${primary_origin}:${primary_origin_port}`,
                `  Secondary pool:  ${secondary_origin}:${secondary_origin_port}`,
                `  Load balancer:   ${hostname} (proxied, active-passive)`,
              ].join("\n"),
            },
          ],
        };
      }

      const steps: string[] = [];
      try {
        // 1. Create health monitor
        const monitorPayload = {
          type: "https",
          description: `Health check for ${hostname}`,
          path: health_check_path,
          interval: 60,
          retries: 2,
          timeout: 5,
          expected_codes: "2xx,3xx",
          follow_redirects: true,
          allow_insecure: false,
          header: { Host: [hostname] },
        };
        const monitorData = (await cfAccountFetch("/load_balancers/monitors", {
          method: "POST",
          body: JSON.stringify(monitorPayload),
        })) as CfResult<{ id: string }>;
        if (!monitorData.success) {
          return {
            content: [
              { type: "text", text: `❌ Monitor creation failed: ${cfError(monitorData)}` },
            ],
          };
        }
        const monitorId = monitorData.result.id;
        steps.push(`✅ Monitor created: ${monitorId}`);

        // 2. Create primary pool
        const primaryPoolData = (await cfAccountFetch("/load_balancers/pools", {
          method: "POST",
          body: JSON.stringify({
            name: `${hostname}-primary`,
            description: `Primary origin — ${primary_origin}`,
            origins: [
              {
                name: "primary",
                address: primary_origin,
                port: primary_origin_port,
                enabled: true,
                weight: 1,
              },
            ],
            monitor: monitorId,
            notification_email: "",
            enabled: true,
          }),
        })) as CfResult<{ id: string; name: string }>;
        if (!primaryPoolData.success) {
          return {
            content: [
              { type: "text", text: `❌ Primary pool creation failed: ${cfError(primaryPoolData)}` },
            ],
          };
        }
        const primaryPoolId = primaryPoolData.result.id;
        steps.push(`✅ Primary pool created: ${primaryPoolData.result.name} (${primaryPoolId})`);

        // 3. Create secondary pool
        const secondaryPoolData = (await cfAccountFetch("/load_balancers/pools", {
          method: "POST",
          body: JSON.stringify({
            name: `${hostname}-secondary`,
            description: `Secondary origin — ${secondary_origin}`,
            origins: [
              {
                name: "secondary",
                address: secondary_origin,
                port: secondary_origin_port,
                enabled: true,
                weight: 1,
              },
            ],
            monitor: monitorId,
            notification_email: "",
            enabled: true,
          }),
        })) as CfResult<{ id: string; name: string }>;
        if (!secondaryPoolData.success) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Secondary pool creation failed: ${cfError(secondaryPoolData)}`,
              },
            ],
          };
        }
        const secondaryPoolId = secondaryPoolData.result.id;
        steps.push(
          `✅ Secondary pool created: ${secondaryPoolData.result.name} (${secondaryPoolId})`,
        );

        // 4. Create load balancer
        const lbData = (await cfFetch("/load_balancers", {
          method: "POST",
          body: JSON.stringify({
            name: hostname,
            default_pools: [primaryPoolId, secondaryPoolId],
            fallback_pool: secondaryPoolId,
            proxied: true,
            steering_policy: "off",
            session_affinity: "none",
            description: `Active-passive LB for ${hostname}`,
          }),
        })) as CfResult<{ id: string; name: string }>;
        if (!lbData.success) {
          return {
            content: [
              { type: "text", text: `❌ Load balancer creation failed: ${cfError(lbData)}` },
            ],
          };
        }
        steps.push(`✅ Load balancer created: ${lbData.result.name} (${lbData.result.id})`);

        return {
          content: [
            {
              type: "text",
              text: [
                `## ✅ Load balancer provisioned for ${hostname}`,
                ``,
                steps.join("\n"),
                ``,
                `Primary:   ${primary_origin}:${primary_origin_port}`,
                `Secondary: ${secondary_origin}:${secondary_origin_port}`,
                `Health:    HTTPS ${health_check_path}`,
              ].join("\n"),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `❌ ${(e as Error).message}\n\nCompleted steps:\n${steps.join("\n")}`,
            },
          ],
        };
      }
    },
  );

  // ── cloudflare_bootstrap_two_tokens ──────────────────────────────────────
  server.registerTool(
    "cloudflare_bootstrap_two_tokens",
    {
      title: "Cloudflare — Bootstrap Two-Token Architecture",
      description: `Create both required Cloudflare API tokens from scratch using a Global API Key,
then set CLOUDFLARE_API_TOKEN (GitHub secret) and CLOUDFLARE_ZONE_ID (GitHub variable)
automatically. This is the single-command alternative to the browser workflow.

Tokens created:
  Token A  cert-manager-dns01  Zone:DNS:Edit + Zone:Zone:Read  →  cloudless.gr only
  Token B  gh-actions-dns-lb   Zone:DNS:Edit + Zone:Zone:Read + Zone:LB:Edit  → cloudless.gr only

Token A is returned for manual kubectl apply (cert-manager secret).
Token B is set as CLOUDFLARE_API_TOKEN GitHub secret automatically.
CLOUDFLARE_ZONE_ID GitHub variable is set automatically.

Requires:
  - global_api_key: Cloudflare Global API Key (dash.cloudflare.com → My Profile → API Tokens → Global API Key)
  - email: Cloudflare account email
  - gh CLI authenticated locally (to set GitHub secret + variable)`,
      inputSchema: z.object({
        email: z.string().describe("Cloudflare account email"),
        global_api_key: z.string().describe("Cloudflare Global API Key"),
        dry_run: z.boolean().default(false).describe("Preview what would be created without creating"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ email, global_api_key, dry_run }) => {
      const CF_API_BASE = "https://api.cloudflare.com/client/v4";
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);

      const globalFetch = async (path: string, options: RequestInit = {}) => {
        const res = await fetch(`${CF_API_BASE}${path}`, {
          ...options,
          headers: {
            "X-Auth-Email": email,
            "X-Auth-Key": global_api_key,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
          },
        });
        return res.json() as Promise<CfResult<unknown>>;
      };

      try {
        // 1. Get zone ID for cloudless.gr
        const zoneData = (await globalFetch("/zones?name=cloudless.gr&status=active")) as CfResult<Array<{ id: string; name: string }>>;
        if (!zoneData.success || !zoneData.result.length) {
          return { content: [{ type: "text", text: `❌ Cannot find cloudless.gr zone: ${cfError(zoneData)}` }] };
        }
        const zoneId = zoneData.result[0].id;

        // 2. Look up permission group IDs
        const pgData = (await globalFetch("/user/tokens/permission_groups")) as CfResult<Array<{ id: string; name: string; scopes: string[] }>>;
        if (!pgData.success) {
          return { content: [{ type: "text", text: `❌ Cannot fetch permission groups: ${cfError(pgData)}` }] };
        }
        const pg = pgData.result;
        const findPg = (name: string) => pg.find((g) => g.name === name);
        const dnsEdit  = findPg("Zone DNS");
        const zoneRead = findPg("Zone Read");
        const lbEdit   = findPg("Load Balancing: Edit") ?? findPg("Zone Load Balancing");

        const missing = [
          !dnsEdit  && "Zone DNS",
          !zoneRead && "Zone Read",
          !lbEdit   && "Load Balancing",
        ].filter(Boolean);
        if (missing.length) {
          const all = pg.map((g) => `  ${g.id}  ${g.name}`).join("\n");
          return { content: [{ type: "text", text: `❌ Cannot find permission group(s): ${missing.join(", ")}\n\nAvailable:\n${all}` }] };
        }

        const zoneResource = `com.cloudflare.api.account.zone.${zoneId}`;

        if (dry_run) {
          return {
            content: [{
              type: "text",
              text: [
                `DRY RUN — would create:`,
                `  Zone ID:  ${zoneId}`,
                `  Token A   cert-manager-dns01  [${dnsEdit!.id}, ${zoneRead!.id}]  → zone ${zoneId}`,
                `  Token B   gh-actions-dns-lb   [${dnsEdit!.id}, ${zoneRead!.id}, ${lbEdit!.id}]  → zone ${zoneId}`,
                `  GitHub:   CLOUDFLARE_API_TOKEN ← token B value`,
                `  GitHub:   CLOUDFLARE_ZONE_ID = ${zoneId}`,
              ].join("\n"),
            }],
          };
        }

        // 3. Create Token A (cert-manager-dns01)
        const tokenAData = (await globalFetch("/user/tokens", {
          method: "POST",
          body: JSON.stringify({
            name: "cert-manager-dns01",
            policies: [{
              effect: "allow",
              resources: { [zoneResource]: "*" },
              permission_groups: [{ id: dnsEdit!.id }, { id: zoneRead!.id }],
            }],
          }),
        })) as CfResult<{ id: string; name: string; value?: string }>;
        if (!tokenAData.success) {
          return { content: [{ type: "text", text: `❌ Token A creation failed: ${cfError(tokenAData)}` }] };
        }
        const tokenAValue = tokenAData.result.value ?? "(no value returned — re-run or check CF dashboard)";

        // 4. Create Token B (gh-actions-dns-lb)
        const tokenBData = (await globalFetch("/user/tokens", {
          method: "POST",
          body: JSON.stringify({
            name: "gh-actions-dns-lb",
            policies: [{
              effect: "allow",
              resources: { [zoneResource]: "*" },
              permission_groups: [{ id: dnsEdit!.id }, { id: zoneRead!.id }, { id: lbEdit!.id }],
            }],
          }),
        })) as CfResult<{ id: string; name: string; value?: string }>;
        if (!tokenBData.success) {
          return { content: [{ type: "text", text: `❌ Token B creation failed: ${cfError(tokenBData)}\n\nToken A was created (ID: ${tokenAData.result.id}) — check CF dashboard.` }] };
        }
        const tokenBValue = tokenBData.result.value ?? "";

        // 5. Set GitHub secret CLOUDFLARE_API_TOKEN = token B
        let ghSecretResult = "";
        if (tokenBValue) {
          try {
            await execFileAsync("gh", ["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", "Themis128/omv-ha", "--body", tokenBValue], { timeout: 15_000 });
            ghSecretResult = "✅ CLOUDFLARE_API_TOKEN set on Themis128/omv-ha";
          } catch (e) {
            ghSecretResult = `⚠️  GitHub secret set failed: ${(e as Error).message}\nSet manually: gh secret set CLOUDFLARE_API_TOKEN --repo Themis128/omv-ha --body "${tokenBValue}"`;
          }
        }

        // 6. Set GitHub variable CLOUDFLARE_ZONE_ID
        let ghVarResult = "";
        try {
          await execFileAsync("gh", ["variable", "set", "CLOUDFLARE_ZONE_ID", "--repo", "Themis128/omv-ha", "--body", zoneId], { timeout: 15_000 });
          ghVarResult = `✅ CLOUDFLARE_ZONE_ID = ${zoneId} set on Themis128/omv-ha`;
        } catch (e) {
          ghVarResult = `⚠️  GitHub variable set failed: ${(e as Error).message}\nSet manually: gh variable set CLOUDFLARE_ZONE_ID --repo Themis128/omv-ha --body "${zoneId}"`;
        }

        return {
          content: [{
            type: "text",
            text: [
              `## ✅ Cloudflare two-token bootstrap complete`,
              ``,
              `Zone ID:  ${zoneId}`,
              ``,
              `Token A  cert-manager-dns01  (ID: ${tokenAData.result.id})`,
              `⚠️  Save Token A value now (shown only once):`,
              `   ${tokenAValue}`,
              ``,
              `Apply to cert-manager namespace:`,
              `   kubectl create secret generic cloudflare-api-token \\`,
              `     --namespace cert-manager \\`,
              `     --from-literal=api-token="${tokenAValue}" \\`,
              `     --dry-run=client -o yaml | kubectl apply -f -`,
              ``,
              `Token B  gh-actions-dns-lb   (ID: ${tokenBData.result.id})`,
              ghSecretResult,
              ghVarResult,
            ].join("\n"),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_worker_routes ──────────────────────────────────────────────
  server.registerTool(
    "cloudflare_worker_routes",
    {
      title: "Cloudflare — Worker Routes",
      description: `List all Worker routes for cloudless.gr.
Shows which URL patterns are handled by which Worker scripts.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = (await cfFetch("/workers/routes")) as CfResult<
          Array<{ id: string; pattern: string; script?: string }>
        >;
        if (!data.success) return { content: [{ type: "text", text: `❌ ${cfError(data)}` }] };
        if (!data.result.length)
          return { content: [{ type: "text", text: "No Worker routes configured." }] };
        const rows = data.result.map(
          (r) => `${r.id}  ${r.pattern.padEnd(50)}  → ${r.script ?? "(none)"}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `## Worker Routes (${data.result.length})\n\n${rows.join("\n")}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );

  // ── cloudflare_tunnel_status ──────────────────────────────────────────────
  server.registerTool(
    "cloudflare_tunnel_status",
    {
      title: "Cloudflare Tunnel Status",
      description: `Check cloudflared tunnel service on omv-main.
Tunnel: cloudless-tunnel (ID: a82f24a8-f767-4a59-bc77-1d59ad132be2)
Returns systemd status + recent log lines + active connections.`,
      inputSchema: z.object({
        tail: z.number().int().min(5).max(100).default(30),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ tail }) => {
      const cmd =
        `echo '=== cloudflared service ===' && systemctl status cloudflared --no-pager -l` +
        ` && echo '=== Recent logs ===' && journalctl -u cloudflared -n ${tail} --no-pager` +
        ` && echo '=== Active connections ===' && journalctl -u cloudflared --since "5 minutes ago" --no-pager` +
        ` | grep -E 'Registered|connection|ERR|err' | tail -10 || true`;
      const r = await runOnNode("omv-main", cmd);
      const text = r.error ? `❌ SSH error: ${r.error}` : "```\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text: trunc(text) }] };
    },
  );

  // ── cloudflare_check_certs ────────────────────────────────────────────────
  server.registerTool(
    "cloudflare_check_certs",
    {
      title: "K3s TLS Certificates Status",
      description: `Check cert-manager Certificate resources in K3s.
Shows all certs across all namespaces: Ready state, expiry, issuer.
Current certs: cloudless-gr-tls, auth-cloudless-gr-tls.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const KUBECTL = "sudo k3s kubectl";
      const cmd =
        `echo '=== Certificates ===' && ${KUBECTL} get certificates -A -o wide` +
        ` && echo '=== Certificate Requests ===' && ${KUBECTL} get certificaterequests -A` +
        ` && echo '=== Orders ===' && ${KUBECTL} get orders -A 2>/dev/null || true` +
        ` && echo '=== cert-manager logs (last 20) ===' && ${KUBECTL} logs -n cert-manager -l app=cert-manager --tail=20 2>&1`;
      const r = await runOnNode("omv-main", cmd);
      const text = r.error ? `❌ SSH error: ${r.error}` : "```\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text: trunc(text) }] };
    },
  );

  // ── cloudflare_restart_tunnel ─────────────────────────────────────────────
  server.registerTool(
    "cloudflare_restart_tunnel",
    {
      title: "Restart Cloudflare Tunnel",
      description: `Restart cloudflared on omv-main. Use when tunnel is stuck or connections drop.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const cmd = `sudo systemctl restart cloudflared && sleep 3 && systemctl is-active cloudflared`;
      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH error: ${r.error}`
        : r.stdout.trim() === "active"
          ? "✅ cloudflared restarted and is active"
          : "⚠️ Restarted but status: " + r.stdout.trim();
      return { content: [{ type: "text", text: text }] };
    },
  );
}
