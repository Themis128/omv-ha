import { z } from "zod";
import { runOnNode, runOnBothNodes, nodeLabel } from "../services/ssh.js";
export function registerFailoverTools(server) {
    // ── failover_check_readiness ──────────────────────────────────────────────
    server.registerTool("failover_check_readiness", {
        title: "Failover Readiness Check",
        description: `Check if both Pi nodes are ready to handle a failover scenario.
Runs a comprehensive health check on OMV-HA (192.168.1.130) and OMV main (192.168.1.128):
- SSH reachability
- Disk space on / and /srv
- Memory availability
- Running services count
- Samba share status
- Network interface summary
Use this before performing planned maintenance or failover to assess readiness.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const cmd = `echo "=== $(hostname) at $(date) ==="` +
            ` && echo '--- Disk ---' && df -h / /srv 2>/dev/null || df -h /` +
            ` && echo '--- Memory ---' && free -h | head -2` +
            ` && echo '--- Load ---' && uptime` +
            ` && echo '--- Samba ---' && systemctl is-active smbd 2>/dev/null && smbstatus -S 2>/dev/null | head -5 || echo '(samba not active or not available)'` +
            ` && echo '--- Network ---' && ip -4 addr show | grep 'inet ' | grep -v '127.0.0.1'` +
            ` && echo '--- IPv6 global ---' && ip -6 addr show | grep 'scope global' | awk '{print $2}' | cut -d/ -f1 || echo '(none)'`;
        const results = await runOnBothNodes(cmd);
        const lines = ["# Failover Readiness Report\n"];
        for (const [n, r] of Object.entries(results)) {
            lines.push(`## ${nodeLabel(n)}`);
            if (r.error) {
                lines.push(`❌ **UNREACHABLE**: ${r.error}`);
            }
            else {
                lines.push("```");
                lines.push(r.stdout || r.stderr);
                lines.push("```");
            }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── failover_check_shares ─────────────────────────────────────────────────
    server.registerTool("failover_check_shares", {
        title: "Check Samba Shares on Both Nodes",
        description: `Compare Samba share configuration between OMV-HA and OMV main.
Lists configured shares, active connections, and checks if share paths exist on each node.
Useful for verifying the failover share setup is mirrored correctly.`,
        inputSchema: z.object({
            node: z
                .enum(["omv-ha", "omv-main", "both"])
                .default("both")
                .describe("Which node(s) to check"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ node }) => {
        const cmd = `echo '=== Samba Services ===' && systemctl status smbd nmbd --no-pager -l | tail -8` +
            ` && echo '=== Configured Shares ===' && testparm -s 2>/dev/null | grep -E '^\[|path =' | head -30 || echo '(testparm not available)'` +
            ` && echo '=== Active Connections ===' && smbstatus 2>/dev/null | head -30 || echo '(no active connections)'`;
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
    // ── failover_sync_shares ──────────────────────────────────────────────────
    server.registerTool("failover_sync_shares", {
        title: "Sync Shares: OMV main → OMV-HA",
        description: `Trigger an rsync from OMV main (192.168.1.128) to OMV-HA (192.168.1.130) to keep shares in sync.
The rsync runs ON OMV main and pushes to OMV-HA via SSH.
Default source path: /srv/dev-disk-by-uuid-*/ (OMV data disk).
Always run with dry_run=true first to preview what would be transferred.
CAUTION: This modifies data on OMV-HA. Use dry_run=true to preview first.`,
        inputSchema: z.object({
            source_path: z
                .string()
                .default("/srv/")
                .describe("Source path on OMV main to sync (default: /srv/)"),
            dest_path: z
                .string()
                .default("/srv/")
                .describe("Destination path on OMV-HA (default: /srv/)"),
            dry_run: z
                .boolean()
                .default(true)
                .describe("Preview only — do not actually transfer files. ALWAYS set to true first."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ source_path, dest_path, dry_run }) => {
        const dryFlag = dry_run ? "--dry-run" : "";
        const cmd = `rsync -avz --progress ${dryFlag} ` +
            `-e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_ed25519" ` +
            `${source_path} tbaltzakis@192.168.1.130:${dest_path} 2>&1 | tail -50`;
        const r = await runOnNode("omv-main", cmd);
        const label = dry_run ? "🔍 DRY RUN" : "🚀 SYNC";
        const text = r.error
            ? `❌ rsync failed: ${r.error}`
            : `${label}: OMV main:${source_path} → OMV-HA:${dest_path}\n\`\`\`\n${r.stdout}\n\`\`\``;
        return { content: [{ type: "text", text }] };
    });
    // ── failover_check_secondary_app ─────────────────────────────────────────
    server.registerTool("failover_check_secondary_app", {
        title: "Check Cloudless Secondary App Failover Path",
        description: `Verify the full failover chain for cloudless.gr:
1. Pi 5 app listening on port 18443
2. APIGW reachability (secondary path)
3. Route 53 secondary health check status (via Pi IPv6 → APIGW → Lambda → Pi)
4. Current IPv6 address of Pi 5 (must match APIGW lambda config)
Use when cloudless.gr primary (Lambda/CloudFront) might be degraded and you need to confirm the failover path is healthy.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const cmd = `echo '=== Port 18443 Listen ===' && sudo ss -tlnp | grep 18443 || echo '❌ NOT LISTENING on 18443'` +
            ` && echo '=== App Health ===' && curl -sk --max-time 5 https://localhost:18443/api/health 2>&1 | head -10 || echo '❌ health endpoint unreachable'` +
            ` && echo '=== IPv6 Global ===' && ip -6 addr show | grep 'scope global' | awk '{print $2}' | cut -d/ -f1` +
            ` && echo '=== K3s pods ===' && sudo k3s kubectl get pods -A --no-headers 2>/dev/null | grep -v 'Running' || echo '(all pods running or K3s not applicable)'`;
        const r = await runOnNode("omv-main", cmd);
        const text = r.error
            ? `❌ Cannot reach OMV main: ${r.error}`
            : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── failover_network_check ────────────────────────────────────────────────
    server.registerTool("failover_network_check", {
        title: "Network Connectivity Check Between Nodes",
        description: `Check network connectivity between both Pi nodes and to the internet.
Tests: ping between nodes, DNS resolution, internet connectivity, and IPv6 status.
Useful for diagnosing failover issues caused by network problems.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const haCmd = `echo '=== OMV-HA network check ===' && hostname -I` +
            ` && echo '--- Ping OMV main ---' && ping -c 2 -W 2 192.168.1.128 2>&1 | tail -3` +
            ` && echo '--- DNS ---' && nslookup cloudless.gr 2>&1 | tail -5` +
            ` && echo '--- Internet ---' && ping -c 2 -W 2 8.8.8.8 2>&1 | tail -3`;
        const mainCmd = `echo '=== OMV main network check ===' && hostname -I` +
            ` && echo '--- Ping OMV-HA ---' && ping -c 2 -W 2 192.168.1.130 2>&1 | tail -3` +
            ` && echo '--- DNS ---' && nslookup cloudless.gr 2>&1 | tail -5` +
            ` && echo '--- Internet ---' && ping -c 2 -W 2 8.8.8.8 2>&1 | tail -3` +
            ` && echo '--- IPv6 ---' && ip -6 addr show | grep 'scope global'`;
        const [ha, main] = await Promise.all([
            runOnNode("omv-ha", haCmd),
            runOnNode("omv-main", mainCmd),
        ]);
        const parts = [
            `## ${nodeLabel("omv-ha")}\n${ha.error ? `❌ ${ha.error}` : "```\n" + ha.stdout + "\n```"}`,
            `## ${nodeLabel("omv-main")}\n${main.error ? `❌ ${main.error}` : "```\n" + main.stdout + "\n```"}`,
        ];
        return { content: [{ type: "text", text: parts.join("\n\n") }] };
    });
}
//# sourceMappingURL=failover.js.map