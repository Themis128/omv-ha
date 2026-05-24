import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import { CHARACTER_LIMIT } from "../constants.js";
const GRAFANA_URL = "http://kube-prom-grafana.monitoring.svc.cluster.local:80";
const GRAFANA_PASSWORD_SSM = "/cloudless/production/GRAFANA_ADMIN_PASSWORD";
/**
 * Build a curl command that authenticates with the Grafana admin password.
 * The password is fetched from SSM on the fly on the Pi; falls back to "admin".
 */
function grafanaCurl(path, extra = "") {
    const fetchPassword = `GRAFANA_PASS=$(aws ssm get-parameter --name "${GRAFANA_PASSWORD_SSM}" --with-decryption --query Parameter.Value --output text 2>/dev/null || echo admin)`;
    const curlCmd = `curl -s -u "admin:$GRAFANA_PASS" ${extra} '${GRAFANA_URL}${path}'`;
    return `${fetchPassword} && ${curlCmd}`;
}
export function registerGrafanaTools(server) {
    // ── grafana_check_health ──────────────────────────────────────────────────
    server.registerTool("grafana_check_health", {
        title: "Grafana — Health Check",
        description: `Check Grafana's health endpoint (/api/health).
Returns the running version, database state, and git commit.
Access is via SSH to omv-main (Grafana is not exposed externally).`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const cmd = grafanaCurl("/api/health");
        const r = await runOnNode("omv-main", cmd);
        if (r.error) {
            return { content: [{ type: "text", text: `❌ SSH error: ${r.error}` }] };
        }
        let parsed = {};
        try {
            parsed = JSON.parse(r.stdout);
        }
        catch {
            return {
                content: [
                    { type: "text", text: `❌ Failed to parse Grafana health response:\n\`\`\`\n${r.stdout}\n\`\`\`` },
                ],
            };
        }
        const dbOk = parsed.database === "ok";
        const lines = [
            "## Grafana Health",
            "",
            `**Version:** ${parsed.version ?? "—"}`,
            `**Database:** ${dbOk ? "✅ ok" : `❌ ${parsed.database ?? "unknown"}`}`,
            `**Commit:** ${parsed.commit ?? "—"}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── grafana_list_dashboards ───────────────────────────────────────────────
    server.registerTool("grafana_list_dashboards", {
        title: "Grafana — List Dashboards",
        description: `List all dashboards in Grafana.
Returns a markdown list with folder, title, and UID for each dashboard.
Use the UID to construct a Grafana URL for direct access.`,
        inputSchema: z.object({
            folder: z
                .string()
                .optional()
                .describe("Filter dashboards by folder name (case-insensitive substring match). Omit to list all."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ folder }) => {
        const cmd = grafanaCurl("/api/search?type=dash-db&limit=500");
        const r = await runOnNode("omv-main", cmd);
        if (r.error) {
            return { content: [{ type: "text", text: `❌ SSH error: ${r.error}` }] };
        }
        let dashboards;
        try {
            dashboards = JSON.parse(r.stdout);
        }
        catch {
            return {
                content: [
                    { type: "text", text: `❌ Failed to parse dashboards response:\n\`\`\`\n${r.stdout}\n\`\`\`` },
                ],
            };
        }
        if (!Array.isArray(dashboards)) {
            return {
                content: [{ type: "text", text: `❌ Unexpected response format:\n\`\`\`\n${r.stdout}\n\`\`\`` }],
            };
        }
        let filtered = dashboards;
        if (folder) {
            const lc = folder.toLowerCase();
            filtered = dashboards.filter((d) => (d.folderTitle ?? "General").toLowerCase().includes(lc));
        }
        if (filtered.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: folder
                            ? `No dashboards found in folder matching "${folder}".`
                            : "No dashboards found in Grafana.",
                    },
                ],
            };
        }
        // Group by folder
        const byFolder = {};
        for (const d of filtered) {
            const f = d.folderTitle ?? "General";
            if (!byFolder[f])
                byFolder[f] = [];
            byFolder[f].push(d);
        }
        const lines = [
            `## Grafana Dashboards`,
            ``,
            `**Total:** ${filtered.length}`,
            ``,
        ];
        for (const [folderName, boards] of Object.entries(byFolder).sort()) {
            lines.push(`### ${folderName}`);
            for (const d of boards) {
                lines.push(`- **${d.title}** — uid: \`${d.uid}\``);
            }
            lines.push("");
        }
        let text = lines.join("\n");
        if (text.length > CHARACTER_LIMIT) {
            text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
        }
        return { content: [{ type: "text", text }] };
    });
    // ── grafana_get_datasources ───────────────────────────────────────────────
    server.registerTool("grafana_get_datasources", {
        title: "Grafana — List Datasources",
        description: `List all configured datasources in Grafana.
Returns name, type, URL, and whether each is the default datasource.
Useful for verifying Prometheus, Loki, or other backends are connected.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const cmd = grafanaCurl("/api/datasources");
        const r = await runOnNode("omv-main", cmd);
        if (r.error) {
            return { content: [{ type: "text", text: `❌ SSH error: ${r.error}` }] };
        }
        let datasources;
        try {
            datasources = JSON.parse(r.stdout);
        }
        catch {
            return {
                content: [
                    { type: "text", text: `❌ Failed to parse datasources response:\n\`\`\`\n${r.stdout}\n\`\`\`` },
                ],
            };
        }
        if (!Array.isArray(datasources) || datasources.length === 0) {
            return { content: [{ type: "text", text: "No datasources configured in Grafana." }] };
        }
        const lines = [
            "## Grafana Datasources",
            "",
            `| Name | Type | URL | Default | Access |`,
            `|------|------|-----|---------|--------|`,
        ];
        for (const ds of datasources) {
            const def = ds.isDefault ? "✅ yes" : "—";
            const url = ds.url ?? "—";
            const access = ds.access ?? "—";
            lines.push(`| \`${ds.name}\` | ${ds.type} | \`${url}\` | ${def} | ${access} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── grafana_restart ───────────────────────────────────────────────────────
    server.registerTool("grafana_restart", {
        title: "Grafana — Restart Deployment",
        description: `Restart the Grafana deployment in the monitoring namespace to pick up ConfigMap or secret changes.
Runs: kubectl rollout restart deployment/kube-prom-grafana -n monitoring
Then waits for the rollout to complete (up to 3 minutes).
Use grafana_check_health after to confirm the new pod is ready.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async () => {
        const restartCmd = `kubectl rollout restart deployment/kube-prom-grafana -n monitoring` +
            ` && kubectl rollout status deployment/kube-prom-grafana -n monitoring --timeout=180s`;
        const r = await runOnNode("omv-main", restartCmd);
        if (r.error) {
            return { content: [{ type: "text", text: `❌ SSH error: ${r.error}` }] };
        }
        const success = r.code === 0;
        const output = [r.stdout, r.stderr].filter(Boolean).join("\n");
        const lines = [
            `## Grafana Restart`,
            ``,
            success ? "✅ Rollout completed successfully." : `❌ Rollout failed (exit code ${r.code}).`,
            ``,
            "```",
            output.slice(0, 2000),
            "```",
        ];
        if (success) {
            lines.push("", "Run `grafana_check_health` to confirm Grafana is healthy.");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── grafana_check_alerts ──────────────────────────────────────────────────
    server.registerTool("grafana_check_alerts", {
        title: "Grafana — Managed Alerts",
        description: `List active Grafana-managed alerts via the Alertmanager API.
Returns alerts with their labels, severity, and when they started firing.
This covers Grafana-managed alert rules (not Prometheus alerting rules — use prometheus_check_alerts for those).`,
        inputSchema: z.object({
            active_only: z
                .boolean()
                .default(true)
                .describe("Only show active (firing) alerts. Set to false to include silenced/inhibited alerts."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ active_only }) => {
        const filterParam = active_only ? "?active=true&silenced=false&inhibited=false" : "";
        const cmd = grafanaCurl(`/api/alertmanager/grafana/api/v2/alerts${filterParam}`);
        const r = await runOnNode("omv-main", cmd);
        if (r.error) {
            return { content: [{ type: "text", text: `❌ SSH error: ${r.error}` }] };
        }
        let alerts;
        try {
            alerts = JSON.parse(r.stdout);
        }
        catch {
            return {
                content: [
                    { type: "text", text: `❌ Failed to parse Grafana alerts response:\n\`\`\`\n${r.stdout}\n\`\`\`` },
                ],
            };
        }
        if (!Array.isArray(alerts)) {
            return {
                content: [{ type: "text", text: `❌ Unexpected response format:\n\`\`\`\n${r.stdout.slice(0, 500)}\n\`\`\`` }],
            };
        }
        if (alerts.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `## Grafana Managed Alerts\n\n✅ No ${active_only ? "active " : ""}alerts.`,
                    },
                ],
            };
        }
        // Group by severity
        const bySeverity = {};
        for (const alert of alerts) {
            const sev = alert.labels?.["severity"] ?? "unknown";
            if (!bySeverity[sev])
                bySeverity[sev] = [];
            bySeverity[sev].push(alert);
        }
        const lines = [
            `## Grafana Managed Alerts`,
            ``,
            `**Total:** ${alerts.length}${active_only ? " (active only)" : ""}`,
            ``,
        ];
        const severityOrder = ["critical", "warning", "info", "unknown"];
        const sortedSeverities = Object.keys(bySeverity).sort((a, b) => (severityOrder.indexOf(a) + 1 || 99) - (severityOrder.indexOf(b) + 1 || 99));
        for (const sev of sortedSeverities) {
            const icon = sev === "critical" ? "🔴" : sev === "warning" ? "🟡" : "🔵";
            lines.push(`### ${icon} ${sev.toUpperCase()} (${bySeverity[sev].length})`);
            lines.push("");
            for (const a of bySeverity[sev]) {
                const name = a.labels?.["alertname"] ?? "unknown";
                const state = a.status?.state ?? "—";
                const startsAt = a.startsAt
                    ? new Date(a.startsAt).toISOString().slice(0, 19) + "Z"
                    : "—";
                const summary = a.annotations?.["summary"] ?? a.annotations?.["message"] ?? "";
                lines.push(`- **${name}** [${state}] — since ${startsAt}${summary ? `\n  > ${summary}` : ""}`);
            }
            lines.push("");
        }
        let text = lines.join("\n");
        if (text.length > CHARACTER_LIMIT) {
            text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
        }
        return { content: [{ type: "text", text }] };
    });
}
//# sourceMappingURL=grafana.js.map