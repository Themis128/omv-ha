import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import { CHARACTER_LIMIT } from "../constants.js";

const PROMETHEUS_URL =
  "http://monitoring-prometheus.monitoring.svc.cluster.local:9090";

function promCurl(path: string): string {
  return `curl -s '${PROMETHEUS_URL}${path}'`;
}

export function registerPrometheusTools(server: McpServer): void {
  // ── prometheus_query ──────────────────────────────────────────────────────
  server.registerTool(
    "prometheus_query",
    {
      title: "Prometheus — PromQL Instant Query",
      description: `Run a PromQL instant query against Prometheus in the monitoring namespace.
Access is via SSH to omv-main (Prometheus is not exposed externally).
Returns the result values formatted as a readable table.
Examples: "up", "kube_pod_status_phase{namespace='default'}", "node_memory_MemAvailable_bytes"`,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'PromQL expression, e.g. "up" or "rate(http_requests_total[5m])"',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ query }) => {
      // Shell-encode: wrap in single quotes but escape any single quotes in query
      const safeQuery = query.replace(/'/g, "'\\''");
      const cmd = promCurl(`/api/v1/query?query=${encodeShell(query)}`);

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }

      let parsed: {
        status?: string;
        data?: {
          resultType?: string;
          result?: Array<{
            metric: Record<string, string>;
            value?: [number, string];
            values?: Array<[number, string]>;
          }>;
        };
        error?: string;
      };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse Prometheus response:\n\`\`\`\n${r.stdout}\n\`\`\``,
            },
          ],
        };
      }

      if (parsed.status !== "success") {
        return {
          content: [
            {
              type: "text",
              text: `❌ Prometheus error: ${parsed.error ?? "unknown"}\n\nStatus: ${parsed.status}`,
            },
          ],
        };
      }

      const resultType = parsed.data?.resultType ?? "unknown";
      const results = parsed.data?.result ?? [];

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `## Prometheus Query: \`${query}\`\n\nNo results returned (empty series).`,
            },
          ],
        };
      }

      const lines: string[] = [
        `## Prometheus Query: \`${query}\``,
        ``,
        `**Result type:** ${resultType}`,
        `**Series count:** ${results.length}`,
        ``,
      ];

      if (resultType === "vector") {
        lines.push("| Metric Labels | Value |");
        lines.push("|---------------|-------|");
        for (const item of results) {
          const labels = formatLabels(item.metric);
          const value = item.value?.[1] ?? "—";
          lines.push(`| ${labels} | \`${value}\` |`);
        }
      } else if (resultType === "matrix") {
        for (const item of results) {
          const labels = formatLabels(item.metric);
          lines.push(`**${labels}**`);
          const vals = (item.values ?? []).slice(-10);
          lines.push("```");
          for (const [ts, val] of vals) {
            lines.push(`${new Date(ts * 1000).toISOString()} → ${val}`);
          }
          lines.push("```");
        }
      } else {
        lines.push("```json");
        lines.push(JSON.stringify(results, null, 2).slice(0, 3000));
        lines.push("```");
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── prometheus_check_targets ──────────────────────────────────────────────
  server.registerTool(
    "prometheus_check_targets",
    {
      title: "Prometheus — Scrape Targets Health",
      description: `List all Prometheus scrape targets and their health status.
Useful for spotting down or unreachable exporters (node-exporter, kube-state-metrics, etc.).
Returns a markdown table: job | endpoint | state | last scrape | error.`,
      inputSchema: z.object({
        state: z
          .enum(["all", "active", "dropped"])
          .default("active")
          .describe(
            'Filter targets by state. Use "all" to include dropped targets.',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ state }) => {
      const stateParam = state === "all" ? "" : `?state=${state}`;
      const cmd = promCurl(`/api/v1/targets${stateParam}`);

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }

      let parsed: {
        status?: string;
        data?: {
          activeTargets?: Array<{
            labels: Record<string, string>;
            scrapeUrl: string;
            health: string;
            lastScrape: string;
            lastError: string;
          }>;
          droppedTargets?: unknown[];
        };
        error?: string;
      };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse targets response:\n\`\`\`\n${r.stdout}\n\`\`\``,
            },
          ],
        };
      }

      if (parsed.status !== "success") {
        return {
          content: [
            {
              type: "text",
              text: `❌ Prometheus error: ${parsed.error ?? "unknown"}`,
            },
          ],
        };
      }

      const activeTargets = parsed.data?.activeTargets ?? [];
      const droppedCount = (parsed.data?.droppedTargets ?? []).length;

      const lines: string[] = [
        `## Prometheus Scrape Targets`,
        ``,
        `**Active:** ${activeTargets.length} | **Dropped:** ${droppedCount}`,
        ``,
        `| Job | Endpoint | Health | Last Scrape | Error |`,
        `|-----|----------|--------|-------------|-------|`,
      ];

      for (const t of activeTargets) {
        const job = t.labels["job"] ?? "—";
        const endpoint = t.scrapeUrl ?? "—";
        const health = t.health === "up" ? "✅ up" : `❌ ${t.health}`;
        const lastScrape = t.lastScrape
          ? new Date(t.lastScrape).toISOString().slice(11, 19) + "Z"
          : "—";
        const err = t.lastError ? t.lastError.slice(0, 60) : "—";
        lines.push(
          `| \`${job}\` | \`${endpoint}\` | ${health} | ${lastScrape} | ${err} |`,
        );
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── prometheus_check_alerts ───────────────────────────────────────────────
  server.registerTool(
    "prometheus_check_alerts",
    {
      title: "Prometheus — Firing Alerts",
      description: `List all currently firing alerts in Prometheus.
Returns alerts grouped by severity (critical, warning, info).
Includes alert name, labels, and the time it started firing.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const cmd = promCurl("/api/v1/alerts");

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }

      let parsed: {
        status?: string;
        data?: {
          alerts?: Array<{
            labels: Record<string, string>;
            annotations: Record<string, string>;
            state: string;
            activeAt: string;
          }>;
        };
        error?: string;
      };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse alerts response:\n\`\`\`\n${r.stdout}\n\`\`\``,
            },
          ],
        };
      }

      if (parsed.status !== "success") {
        return {
          content: [
            {
              type: "text",
              text: `❌ Prometheus error: ${parsed.error ?? "unknown"}`,
            },
          ],
        };
      }

      const alerts = (parsed.data?.alerts ?? []).filter(
        (a) => a.state === "firing",
      );

      if (alerts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "## Prometheus Alerts\n\n✅ No firing alerts.",
            },
          ],
        };
      }

      // Group by severity
      const bySeverity: Record<string, typeof alerts> = {};
      for (const alert of alerts) {
        const sev = alert.labels["severity"] ?? "unknown";
        if (!bySeverity[sev]) bySeverity[sev] = [];
        bySeverity[sev].push(alert);
      }

      const lines: string[] = [
        `## Prometheus Firing Alerts`,
        ``,
        `**Total firing:** ${alerts.length}`,
        ``,
      ];

      const severityOrder = ["critical", "warning", "info", "unknown"];
      const sortedSeverities = Object.keys(bySeverity).sort(
        (a, b) =>
          (severityOrder.indexOf(a) + 1 || 99) -
          (severityOrder.indexOf(b) + 1 || 99),
      );

      for (const sev of sortedSeverities) {
        const icon =
          sev === "critical" ? "🔴" : sev === "warning" ? "🟡" : "🔵";
        lines.push(
          `### ${icon} ${sev.toUpperCase()} (${bySeverity[sev].length})`,
        );
        lines.push("");
        for (const a of bySeverity[sev]) {
          const name = a.labels["alertname"] ?? "unknown";
          const activeAt = a.activeAt
            ? new Date(a.activeAt).toISOString().slice(0, 19) + "Z"
            : "—";
          const summary =
            a.annotations["summary"] ?? a.annotations["message"] ?? "";
          lines.push(
            `- **${name}** — firing since ${activeAt}${summary ? `\n  > ${summary}` : ""}`,
          );
        }
        lines.push("");
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── prometheus_check_rules ────────────────────────────────────────────────
  server.registerTool(
    "prometheus_check_rules",
    {
      title: "Prometheus — Rules Summary",
      description: `List all recording and alerting rules loaded in Prometheus.
Returns a summary per rule group: group name, file, rule count, and individual rule names.
Useful for auditing what alerting rules are active.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const cmd = promCurl("/api/v1/rules");

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }

      let parsed: {
        status?: string;
        data?: {
          groups?: Array<{
            name: string;
            file: string;
            rules: Array<{ name?: string; record?: string; type: string }>;
          }>;
        };
        error?: string;
      };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse rules response:\n\`\`\`\n${r.stdout}\n\`\`\``,
            },
          ],
        };
      }

      if (parsed.status !== "success") {
        return {
          content: [
            {
              type: "text",
              text: `❌ Prometheus error: ${parsed.error ?? "unknown"}`,
            },
          ],
        };
      }

      const groups = parsed.data?.groups ?? [];
      if (groups.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "## Prometheus Rules\n\nNo rule groups found.",
            },
          ],
        };
      }

      const totalRules = groups.reduce((sum, g) => sum + g.rules.length, 0);
      const lines: string[] = [
        `## Prometheus Rules`,
        ``,
        `**Rule groups:** ${groups.length} | **Total rules:** ${totalRules}`,
        ``,
        `| Group | File | Alerting | Recording |`,
        `|-------|------|----------|-----------|`,
      ];

      for (const g of groups) {
        const alerting = g.rules.filter((r) => r.type === "alerting").length;
        const recording = g.rules.filter((r) => r.type === "recording").length;
        const file = g.file.split("/").pop() ?? g.file;
        lines.push(
          `| \`${g.name}\` | \`${file}\` | ${alerting} | ${recording} |`,
        );
      }

      lines.push("", "### Alerting Rule Names", "");
      for (const g of groups) {
        const alertRules = g.rules.filter((r) => r.type === "alerting");
        if (alertRules.length > 0) {
          lines.push(
            `**${g.name}:** ${alertRules.map((r) => `\`${r.name ?? "?"}\``).join(", ")}`,
          );
        }
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
      }
      return { content: [{ type: "text", text }] };
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Prometheus metric label set for table display */
function formatLabels(metric: Record<string, string>): string {
  const entries = Object.entries(metric);
  if (entries.length === 0) return "(no labels)";
  const name = metric["__name__"];
  const rest = entries.filter(([k]) => k !== "__name__");
  const labelStr = rest.map(([k, v]) => `${k}="${v}"`).join(", ");
  if (name) {
    return labelStr ? `\`${name}{${labelStr}}\`` : `\`${name}\``;
  }
  return `\`{${labelStr}}\``;
}

/**
 * Percent-encode a PromQL query for inclusion in a shell single-quoted curl URL.
 * We use Python's urllib to do the encoding on the Pi rather than building it here,
 * but for simplicity we construct the URL via shell printf %s and Python urlencode.
 */
function encodeShell(query: string): string {
  // Use python3 to URL-encode the query on the remote side — but that requires
  // a separate SSH round-trip. Instead, encode common unsafe characters here.
  // Characters safe in URL query values (RFC 3986 unreserved + some): A-Z a-z 0-9 - _ . ~
  // Everything else gets percent-encoded.
  return encodeURIComponent(query);
}
