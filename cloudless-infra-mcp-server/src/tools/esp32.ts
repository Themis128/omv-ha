import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Alert API — FastAPI pod in alert-manager ns, NodePort 30800 on omv-main (192.168.1.128)
const ALERT_API = "http://192.168.1.128:30800";

async function apiGet(
  path: string,
): Promise<{ data?: unknown; error?: string }> {
  try {
    const res = await fetch(`${ALERT_API}${path}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: String(e) };
  }
}

const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
  info: "ℹ️",
};

const STATUS_ICON: Record<string, string> = {
  RESOLVED: "✅",
  FIRING: "🔥",
  ONGOING: "🔄",
  FLAP_SUPPRESSED: "🔇",
};

export function registerEsp32Tools(server: McpServer): void {
  // ── esp32_alert_status ────────────────────────────────────────────────────
  server.registerTool(
    "esp32_alert_status",
    {
      title: "ESP32 Active Alerts",
      description: `Query active (non-resolved) alerts from the Alert API.
The Alert API (FastAPI, alert-manager namespace, NodePort 30800) receives TCP/HTTP probes
from the ESP32 watchdog device (192.168.1.201) every 30 seconds.
Returns all currently active alerts with code, severity, trigger count, and last seen time.
Use to check if any cluster or dependency issues are currently firing.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const result = await apiGet("/api/alerts/active");
      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Alert API unreachable at ${ALERT_API}: ${result.error}\nCheck: kubectl get pods -n alert-manager`,
            },
          ],
        };
      }
      const alerts = result.data as Array<Record<string, unknown>>;
      if (!alerts.length) {
        return {
          content: [{ type: "text", text: "✅ No active alerts — all cluster checks clean." }],
        };
      }
      const lines = [`## Active Alerts (${alerts.length})`, ""];
      for (const a of alerts) {
        const sev = String(a.severity ?? "unknown");
        const icon = SEVERITY_ICON[sev] ?? "⚪";
        lines.push(`${icon} **${a.code}** — ${sev.toUpperCase()}`);
        lines.push(`   message: ${a.message}`);
        lines.push(`   status: ${a.status}  count: ${a.count}  last_seen: ${a.last_seen ?? a.updated_at}`);
        if (a.auto_fix) lines.push(`   auto-fix: ${a.auto_fix}`);
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── esp32_alert_resolve ───────────────────────────────────────────────────
  server.registerTool(
    "esp32_alert_resolve",
    {
      title: "Resolve ESP32 Alert",
      description: `Manually resolve an active alert in the Alert API.
Use after confirming the underlying issue is fixed or auto-remediation has run.
The alert remains in history as resolved and will re-fire if the ESP32 detects the problem again.
Common codes: OMV_MAIN_K3S_API_DOWN, OMV_HA_K3S_AGENT_DOWN, CLOUDLESS_ONLINE_DOWN, OMV_MAIN_NFS_DOWN.`,
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .describe(
            "Alert code to resolve (e.g. OMV_MAIN_K3S_API_DOWN, CLOUDLESS_ONLINE_DOWN)",
          ),
        resolved_by: z
          .string()
          .default("claude-agent")
          .describe("Who resolved it — stored in alert history"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ code, resolved_by }) => {
      try {
        const res = await fetch(
          `${ALERT_API}/api/alerts/${encodeURIComponent(code)}/resolve?resolved_by=${encodeURIComponent(resolved_by)}`,
          { method: "PATCH", signal: AbortSignal.timeout(8000) },
        );
        const body = await res.text();
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `❌ HTTP ${res.status}: ${body}` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `✅ Alert **${code}** resolved by \`${resolved_by}\`\n\`\`\`\n${body}\n\`\`\``,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ Alert API error: ${e}` }],
        };
      }
    },
  );

  // ── esp32_alert_history ───────────────────────────────────────────────────
  server.registerTool(
    "esp32_alert_history",
    {
      title: "ESP32 Alert History",
      description: `Retrieve recent alert event history from the Alert API.
Returns the last N events across all alert codes (FIRING, RESOLVED, ONGOING, FLAP_SUPPRESSED).
FLAP_SUPPRESSED = ESP32 fired an alert but the Alert API's cluster-side check confirmed the service was up (false positive suppressed).
Useful for post-incident analysis and identifying flapping services.`,
      inputSchema: z.object({
        limit: z
          .number()
          .min(10)
          .max(200)
          .default(50)
          .describe("Number of history entries to return (default 50)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ limit }) => {
      const result = await apiGet(`/api/alerts/history?limit=${limit}`);
      if (result.error) {
        return {
          content: [{ type: "text", text: `❌ Alert API unreachable: ${result.error}` }],
        };
      }
      const history = result.data as Array<Record<string, unknown>>;
      if (!history.length) {
        return { content: [{ type: "text", text: "No alert history found." }] };
      }
      const lines = [`## Alert History (last ${limit})`, ""];
      for (const h of history) {
        const status = String(h.status ?? "");
        const icon = STATUS_ICON[status] ?? "⚪";
        const ts = String(h.created_at ?? h.timestamp ?? "");
        lines.push(`${icon} \`${h.code}\` — **${status}** at ${ts}`);
        if (h.message) lines.push(`   ${h.message}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── esp32_device_status ───────────────────────────────────────────────────
  server.registerTool(
    "esp32_device_status",
    {
      title: "ESP32 Device & System Status",
      description: `Get the current hardware state of the ESP32 watchdog (192.168.1.201) and combined cluster health.
ESP32 hardware data: IP, firmware version, RSSI signal strength, free RAM, uptime, boot count, last heartbeat.
System status: combined Pi node + ESP32 + alert summary from the Alert API.
RSSI guide: ≥ −65 dBm 🟢 good / ≥ −80 dBm 🟡 marginal / < −80 dBm 🔴 poor.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const [esp32Result, systemResult] = await Promise.all([
        apiGet("/api/esp32/status"),
        apiGet("/api/status"),
      ]);

      const lines: string[] = ["## ESP32 Watchdog Hardware Status", ""];

      if (esp32Result.error) {
        lines.push(`❌ ESP32 status unreachable: ${esp32Result.error}`);
        lines.push("ESP32 may be offline or Alert API pod is down.");
      } else {
        const d = esp32Result.data as Record<string, unknown>;
        const rssi = Number(d.rssi ?? 0);
        const rssiIcon = rssi >= -65 ? "🟢" : rssi >= -80 ? "🟡" : "🔴";
        lines.push(`**Firmware:** \`${d.firmware_version ?? "unknown"}\`  |  **IP:** ${d.ip ?? "—"}`);
        lines.push(`**Signal:** ${rssiIcon} ${rssi} dBm  |  **Free RAM:** ${d.free_ram ?? "—"} bytes`);
        lines.push(`**Uptime:** ${d.uptime ?? "—"} s  |  **Boot count:** ${d.boot_count ?? "—"}`);
        lines.push(`**Last heartbeat:** ${d.last_heartbeat ?? "—"}`);
        if (d.device_id) lines.push(`**Device ID:** ${d.device_id}`);
      }

      lines.push("");
      lines.push("## System Status (Pi + Alert Summary)");
      lines.push("");

      if (systemResult.error) {
        lines.push(`❌ System status unreachable: ${systemResult.error}`);
      } else {
        lines.push("```json");
        lines.push(JSON.stringify(systemResult.data, null, 2));
        lines.push("```");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
