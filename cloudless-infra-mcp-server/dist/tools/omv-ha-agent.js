import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
const KUBECTL = "sudo k3s kubectl";
// K3S_URL + K3S_TOKEN for omv-ha agent reinstall (from k3s-agent.service.env)
const K3S_URL = "https://192.168.1.200:6443";
const K3S_TOKEN = "K1088dbec5a8ca41f4a18407ee401a84f8dab673d42c7a3e3c391c2efae64ea0334::server:75800c077d78cfae7fd7dbf8dce58c04";
export function registerOmvHaAgentTools(server) {
    // ── omv_ha_agent_status ───────────────────────────────────────────────────
    server.registerTool("omv_ha_agent_status", {
        title: "omv-ha k3s Agent Status",
        description: `Check the k3s-agent service on omv-ha (Pi 4, 192.168.1.130).
omv-ha was demoted from control-plane+etcd to agent-only on 2026-05-24 to fix 2-node etcd instability.
Returns: k3s-agent service state, keepalived state, recent agent logs, memory, load average, and swap.
Also verifies omv-ha appears in kubectl nodes with role <none> (not control-plane,etcd).`,
        inputSchema: z.object({
            tail: z
                .number()
                .min(5)
                .max(100)
                .default(20)
                .describe("Number of k3s-agent log lines to show"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ tail }) => {
        const haCmd = [
            "echo '=== k3s-agent ===' && systemctl is-active k3s-agent",
            `systemctl status k3s-agent --no-pager -l | tail -${tail}`,
            "echo '=== keepalived ===' && systemctl is-active keepalived",
            "systemctl status keepalived --no-pager | tail -5",
            "echo '=== Memory ===' && free -h",
            "echo '=== Load ===' && cat /proc/loadavg",
            "echo '=== Swap ===' && swapon --show 2>/dev/null || echo '(none)'",
        ].join(" && ");
        const mainCmd = `${KUBECTL} get nodes -o wide`;
        const [haResult, mainResult] = await Promise.all([
            runOnNode("omv-ha", haCmd),
            runOnNode("omv-main", mainCmd),
        ]);
        const lines = [
            "## omv-ha — k3s Agent Status",
            "",
            haResult.error
                ? `❌ SSH failed: ${haResult.error}`
                : "```\n" + haResult.stdout + "\n```",
            "",
            "## Cluster Nodes (from omv-main)",
            "",
            mainResult.error
                ? `❌ SSH failed: ${mainResult.error}`
                : "```\n" + mainResult.stdout + "\n```",
            "",
            "> omv-ha must show role `<none>` — demoted 2026-05-24. If it shows `control-plane,etcd` something went wrong.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── omv_ha_agent_restart ──────────────────────────────────────────────────
    server.registerTool("omv_ha_agent_restart", {
        title: "Restart k3s-agent on omv-ha",
        description: `Restart the k3s-agent systemd service on omv-ha (Pi 4, 192.168.1.130).
Use when omv-ha shows NotReady in kubectl nodes, or when k3s-agent is stuck/crashed.
Waits 5 seconds and reports the new service state.
This does NOT re-register the node — use omv_ha_agent_rejoin for a full reinstall.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async () => {
        const cmd = "sudo systemctl restart k3s-agent" +
            " && sleep 5" +
            " && echo '=== k3s-agent post-restart ===' && systemctl is-active k3s-agent" +
            " && systemctl status k3s-agent --no-pager | tail -8";
        const r = await runOnNode("omv-ha", cmd);
        const text = r.error
            ? `❌ SSH to omv-ha failed: ${r.error}`
            : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── omv_ha_agent_rejoin ───────────────────────────────────────────────────
    server.registerTool("omv_ha_agent_rejoin", {
        title: "Rejoin omv-ha as k3s Agent (Full Reinstall)",
        description: `Full reinstall of k3s-agent on omv-ha after a hard disconnect.
Use ONLY when omv-ha is completely missing from kubectl nodes (not just NotReady).
Procedure (from Runbook — omv-ha Demotion: server → agent, 2026-05-24):
  Step 1: Delete node object from cluster (on omv-main)
  Step 2: Uninstall k3s-agent on omv-ha (k3s-agent-uninstall.sh)
  Step 3: Reinstall k3s-agent via get.k3s.io
  Step 4: Write env file with K3S_URL, K3S_TOKEN, GOGC=50
CAUTION: run_commands=true is destructive. Default false shows the commands only.`,
        inputSchema: z.object({
            run_commands: z
                .boolean()
                .default(false)
                .describe("Set true to execute the full reinstall. Default false shows the steps as a dry run."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ run_commands }) => {
        const envFileContent = `K3S_URL=${K3S_URL}\nK3S_TOKEN=${K3S_TOKEN}\nGOGC=50`;
        const preview = [
            "## omv-ha Agent Rejoin — Steps",
            "",
            "```bash",
            "# Step 1 — Delete node from cluster (on omv-main)",
            `${KUBECTL} delete node omv-ha`,
            "",
            "# Step 2 — Uninstall k3s-agent on omv-ha",
            "sudo /usr/local/bin/k3s-agent-uninstall.sh",
            "",
            "# Step 3 — Reinstall k3s-agent",
            `curl -sfL https://get.k3s.io | K3S_URL=${K3S_URL} K3S_TOKEN=${K3S_TOKEN} sh -s - agent`,
            "",
            "# Step 4 — Write env file (preserves GOGC=50 GC tuning)",
            "sudo bash -c 'cat > /etc/systemd/system/k3s-agent.service.env << EOF",
            envFileContent,
            "EOF",
            "systemctl daemon-reload && systemctl start k3s-agent'",
            "```",
            "",
            "> Source: Runbook — omv-ha Demotion 2026-05-24",
            "> Set `run_commands=true` to execute.",
        ].join("\n");
        if (!run_commands) {
            return { content: [{ type: "text", text: preview }] };
        }
        const results = ["## omv-ha Agent Rejoin — Executing\n"];
        // Step 1: delete node object on omv-main
        results.push("### Step 1: Delete node from cluster");
        const del = await runOnNode("omv-main", `${KUBECTL} delete node omv-ha --ignore-not-found`);
        results.push(del.error ? `❌ ${del.error}` : "```\n" + del.stdout + "\n```");
        // Steps 2–4 on omv-ha: uninstall + reinstall + env file
        results.push("\n### Steps 2–4: Uninstall + reinstall on omv-ha");
        const installCmd = [
            "sudo /usr/local/bin/k3s-agent-uninstall.sh 2>/dev/null || true",
            `curl -sfL https://get.k3s.io | K3S_URL=${K3S_URL} K3S_TOKEN=${K3S_TOKEN} sh -s - agent`,
            `sudo bash -c 'printf "${envFileContent.replace(/\n/g, "\\n")}" > /etc/systemd/system/k3s-agent.service.env && systemctl daemon-reload && systemctl start k3s-agent'`,
        ].join(" && ");
        const install = await runOnNode("omv-ha", installCmd);
        results.push(install.error ? `❌ ${install.error}` : "```\n" + install.stdout + "\n```");
        // Verify
        results.push("\n### Verification (waiting 8s for agent to connect)");
        await new Promise((resolve) => setTimeout(resolve, 8000));
        const verify = await runOnNode("omv-main", `${KUBECTL} get nodes -o wide`);
        results.push(verify.error ? `❌ ${verify.error}` : "```\n" + verify.stdout + "\n```");
        results.push("\n> omv-ha should show `<none>` role and `Ready` status within ~30s.");
        return { content: [{ type: "text", text: results.join("\n") }] };
    });
}
//# sourceMappingURL=omv-ha-agent.js.map