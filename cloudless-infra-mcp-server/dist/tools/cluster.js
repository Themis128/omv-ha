import { z } from "zod";
import { runOnNode, runOnBothNodes, nodeLabel } from "../services/ssh.js";
const NodeSchema = z
    .enum(["omv-ha", "omv-main"])
    .describe('Target Pi node: "omv-ha" (192.168.1.130) or "omv-main" (192.168.1.128, Pi 5)');
export function registerClusterTools(server) {
    // ── cluster_health_check ──────────────────────────────────────────────────
    server.registerTool("cluster_health_check", {
        title: "Pi Cluster Health Check",
        description: `Check the health of one or both Raspberry Pi nodes.
Returns: hostname, uptime, disk usage, free memory, load average, and running service count.
Use this as a first step to assess overall cluster state.`,
        inputSchema: z.object({
            node: z
                .enum(["omv-ha", "omv-main", "both"])
                .default("both")
                .describe("Which node(s) to check"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ node }) => {
        const cmd = 'echo "=== $(hostname) ==="' +
            " && uptime" +
            " && echo '--- Disk ---'" +
            " && df -h / /srv 2>/dev/null || df -h /" +
            " && echo '--- Memory ---'" +
            " && free -h" +
            " && echo '--- Load ---'" +
            " && cat /proc/loadavg" +
            " && echo '--- Services ---'" +
            " && systemctl list-units --type=service --state=running --no-legend | wc -l";
        let text;
        if (node === "both") {
            const results = await runOnBothNodes(cmd);
            const lines = [];
            for (const [n, r] of Object.entries(results)) {
                lines.push(`## ${nodeLabel(n)}`);
                if (r.error) {
                    lines.push(`❌ Connection failed: ${r.error}`);
                }
                else {
                    lines.push("```");
                    lines.push(r.stdout || r.stderr);
                    lines.push("```");
                }
            }
            text = lines.join("\n");
        }
        else {
            const r = await runOnNode(node, cmd);
            text = r.error
                ? `❌ ${nodeLabel(node)}: ${r.error}`
                : `## ${nodeLabel(node)}\n\`\`\`\n${r.stdout || r.stderr}\n\`\`\``;
        }
        return { content: [{ type: "text", text }] };
    });
    // ── cluster_run_command ───────────────────────────────────────────────────
    server.registerTool("cluster_run_command", {
        title: "Run Command on Pi Node",
        description: `Execute an arbitrary shell command on a specified Pi node via SSH.
Use for ad-hoc diagnostics. Returns stdout + stderr + exit code.
CAUTION: avoid commands that modify system state unless you know what you are doing.`,
        inputSchema: z.object({
            node: NodeSchema,
            command: z
                .string()
                .min(1)
                .max(500)
                .describe("Shell command to run on the node"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ node, command }) => {
        const r = await runOnNode(node, command);
        const label = nodeLabel(node);
        const parts = [
            `## ${label}`,
            `**Command:** \`${command}\``,
            `**Exit code:** ${r.code}`,
        ];
        if (r.stdout)
            parts.push("**stdout:**\n```\n" + r.stdout + "\n```");
        if (r.stderr)
            parts.push("**stderr:**\n```\n" + r.stderr + "\n```");
        return { content: [{ type: "text", text: parts.join("\n") }] };
    });
    // ── cluster_check_services ────────────────────────────────────────────────
    server.registerTool("cluster_check_services", {
        title: "Check Running Services on Pi Node",
        description: `List all running systemd services on a Pi node.
Useful to verify which services are active and spot unexpected stopped services.
Also shows failed units if any.`,
        inputSchema: z.object({
            node: z
                .enum(["omv-ha", "omv-main", "both"])
                .default("both")
                .describe("Which node(s) to check"),
            show_failed: z
                .boolean()
                .default(true)
                .describe("Also show failed units"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ node, show_failed }) => {
        const cmd = "systemctl list-units --type=service --state=running --no-legend" +
            (show_failed
                ? " && echo '--- Failed ---' && systemctl --failed --no-legend 2>/dev/null || true"
                : "");
        const run = async (n) => {
            const r = await runOnNode(n, cmd);
            return `## ${nodeLabel(n)}\n${r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```"}`;
        };
        let text;
        if (node === "both") {
            const [ha, main] = await Promise.all([run("omv-ha"), run("omv-main")]);
            text = [ha, main].join("\n\n");
        }
        else {
            text = await run(node);
        }
        return { content: [{ type: "text", text }] };
    });
    // ── cluster_check_omv ─────────────────────────────────────────────────────
    server.registerTool("cluster_check_omv", {
        title: "Check OpenMediaVault (NAS) Status",
        description: `Check OpenMediaVault NAS services on a Pi node.
Checks Samba (file sharing), openmediavault-engined, and lists active Samba connections.`,
        inputSchema: z.object({
            node: z
                .enum(["omv-ha", "omv-main", "both"])
                .default("both")
                .describe("Which node(s) to check"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ node }) => {
        const cmd = "echo '=== Samba ===' && systemctl is-active smbd nmbd" +
            " && echo '=== OMV Engine ===' && systemctl is-active openmediavault-engined" +
            " && echo '=== Samba Connections ===' && smbstatus -S 2>/dev/null | head -30 || echo '(none or not available)'";
        const run = async (n) => {
            const r = await runOnNode(n, cmd);
            return `## ${nodeLabel(n)}\n${r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```"}`;
        };
        let text;
        if (node === "both") {
            const [ha, main] = await Promise.all([run("omv-ha"), run("omv-main")]);
            text = [ha, main].join("\n\n");
        }
        else {
            text = await run(node);
        }
        return { content: [{ type: "text", text }] };
    });
}
//# sourceMappingURL=cluster.js.map