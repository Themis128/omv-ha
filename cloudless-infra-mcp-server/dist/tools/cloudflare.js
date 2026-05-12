import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID } from "../constants.js";
const CF_BASE = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}`;
async function cfFetch(path, options = {}) {
    const res = await fetch(`${CF_BASE}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
        },
    });
    return res.json();
}
export function registerCloudflareTools(server) {
    // ── cloudflare_list_dns_records ───────────────────────────────────────────
    server.registerTool("cloudflare_list_dns_records", {
        title: "Cloudflare — List DNS Records",
        description: `List all DNS records for cloudless.online in Cloudflare.
Returns record ID, type, name, content, TTL, and proxied status.
Useful to inspect current state before adding or deleting records.`,
        inputSchema: z.object({
            type: z
                .enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS"])
                .optional()
                .describe("Filter by record type (omit for all)"),
            name: z
                .string()
                .optional()
                .describe('Filter by name, e.g. "auth.cloudless.online"'),
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
        if (!data.success) {
            const msg = data.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
            return { content: [{ type: "text", text: `❌ Cloudflare API error: ${msg}` }] };
        }
        if (data.result.length === 0) {
            return { content: [{ type: "text", text: "No DNS records found." }] };
        }
        const rows = data.result.map((r) => `${r.id}  ${r.type.padEnd(6)}  ${r.name.padEnd(35)}  ${r.content}  TTL=${r.ttl}  proxied=${r.proxied}`);
        const text = `DNS records for cloudless.online (${data.result.length}):\n\n` + rows.join("\n");
        return { content: [{ type: "text", text }] };
    });
    // ── cloudflare_add_dns_record ─────────────────────────────────────────────
    server.registerTool("cloudflare_add_dns_record", {
        title: "Cloudflare — Add DNS Record",
        description: `Add a new DNS record to cloudless.online in Cloudflare.
Supports A, AAAA, CNAME, and TXT records.
For CNAME tunnel records use content="<tunnel-id>.cfargotunnel.com" and proxied=true.`,
        inputSchema: z.object({
            type: z.enum(["A", "AAAA", "CNAME", "TXT"]).describe("Record type"),
            name: z
                .string()
                .describe('Record name — use "@" for apex, or e.g. "staging", "*.cloudless.online"'),
            content: z
                .string()
                .describe("Record value — IP address, target hostname, or TXT string"),
            ttl: z
                .number()
                .int()
                .default(1)
                .describe("TTL in seconds (1 = Cloudflare auto)"),
            proxied: z
                .boolean()
                .default(true)
                .describe("Whether to proxy through Cloudflare (orange cloud)"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ type, name, content, ttl, proxied }) => {
        const data = (await cfFetch("/dns_records", {
            method: "POST",
            body: JSON.stringify({ type, name, content, ttl, proxied }),
        }));
        if (!data.success) {
            const msg = data.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
            return { content: [{ type: "text", text: `❌ Failed: ${msg}` }] };
        }
        const r = data.result;
        return {
            content: [
                {
                    type: "text",
                    text: `✅ Created ${r.type} record "${r.name}" → ${r.content} (ID: ${r.id})`,
                },
            ],
        };
    });
    // ── cloudflare_delete_dns_record ──────────────────────────────────────────
    server.registerTool("cloudflare_delete_dns_record", {
        title: "Cloudflare — Delete DNS Record",
        description: `Delete a DNS record from cloudless.online by record ID.
Use cloudflare_list_dns_records first to get the record ID.
This action is irreversible — double-check the ID before deleting.`,
        inputSchema: z.object({
            record_id: z
                .string()
                .describe("Cloudflare DNS record ID (32-char hex string)"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ record_id }) => {
        const data = (await cfFetch(`/dns_records/${record_id}`, {
            method: "DELETE",
        }));
        if (!data.success) {
            const msg = data.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
            return { content: [{ type: "text", text: `❌ Failed: ${msg}` }] };
        }
        return {
            content: [{ type: "text", text: `✅ Deleted DNS record ${record_id}` }],
        };
    });
    // ── cloudflare_tunnel_status ──────────────────────────────────────────────
    server.registerTool("cloudflare_tunnel_status", {
        title: "Cloudflare Tunnel Status",
        description: `Check the cloudflared tunnel service status on omv-main (Pi 5).
Tunnel name: cloudless-tunnel (ID: a82f24a8-f767-4a59-bc77-1d59ad132be2)
Returns: systemd service status, recent log lines, and active connections.
Use this to diagnose public connectivity issues to cloudless.online.`,
        inputSchema: z.object({
            tail: z
                .number()
                .int()
                .min(5)
                .max(100)
                .default(30)
                .describe("Number of recent log lines to include"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ tail }) => {
        const cmd = `echo '=== cloudflared service ===' && systemctl status cloudflared --no-pager -l` +
            ` && echo '=== Recent logs ===' && journalctl -u cloudflared -n ${tail} --no-pager` +
            ` && echo '=== Active connections ===' && journalctl -u cloudflared --since "5 minutes ago" --no-pager | grep -E 'Registered|connection|ERR|err' | tail -10 || true`;
        const r = await runOnNode("omv-main", cmd);
        const text = r.error ? `❌ SSH error: ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── cloudflare_check_certs ────────────────────────────────────────────────
    server.registerTool("cloudflare_check_certs", {
        title: "K3s TLS Certificates Status",
        description: `Check the status of TLS certificates managed by cert-manager in K3s.
Shows all Certificate resources across all namespaces with their Ready state, expiry, and issuer.
Current certs: cloudless-online-tls (cloudless.online + www), auth-cloudless-online-tls (auth.cloudless.online).
Use this to confirm cert renewal worked or to diagnose HTTPS issues.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const KUBECTL = "sudo k3s kubectl";
        const cmd = `echo '=== Certificates ===' && ${KUBECTL} get certificates -A -o wide` +
            ` && echo '=== Certificate Requests ===' && ${KUBECTL} get certificaterequests -A` +
            ` && echo '=== Orders ===' && ${KUBECTL} get orders -A 2>/dev/null || true` +
            ` && echo '=== cert-manager logs (last 20) ===' && ${KUBECTL} logs -n cert-manager -l app=cert-manager --tail=20 2>&1`;
        const r = await runOnNode("omv-main", cmd);
        const text = r.error ? `❌ SSH error: ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── cloudflare_restart_tunnel ─────────────────────────────────────────────
    server.registerTool("cloudflare_restart_tunnel", {
        title: "Restart Cloudflare Tunnel",
        description: `Restart the cloudflared systemd service on omv-main.
Use this when the tunnel is stuck, connections are dropping, or after config changes.
Tunnel recovers automatically (http2 protocol, stable behind CGNAT).`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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