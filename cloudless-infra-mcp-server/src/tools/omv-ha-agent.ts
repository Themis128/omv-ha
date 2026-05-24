import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import { K3S_TRAEFIK_VIP } from "../constants.js";

const KUBECTL = "sudo k3s kubectl";
const K3S_URL = `https://${K3S_TRAEFIK_VIP}:6443`;

// omv-main uses a non-default k3s data-dir on the external drive
const K3S_DATA_DIR =
  "/srv/dev-disk-by-uuid-a9a5a108-8095-4b7b-8011-716889995cd7/k3s";
const NODE_TOKEN_PATH = `${K3S_DATA_DIR}/server/node-token`;

async function fetchK3sToken(): Promise<string> {
  const r = await runOnNode("omv-main", `sudo cat ${NODE_TOKEN_PATH}`);
  if (r.error) throw new Error(`Could not read node-token from omv-main: ${r.error}`);
  return r.stdout.trim();
}

export function registerOmvHaAgentTools(server: McpServer): void {
  // ── omv_ha_agent_status ───────────────────────────────────────────────────
  server.registerTool(
    "omv_ha_agent_status",
    {
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
    },
    async ({ tail }) => {
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

      const lines: string[] = [
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
    },
  );

  // ── omv_ha_agent_restart ──────────────────────────────────────────────────
  server.registerTool(
    "omv_ha_agent_restart",
    {
      title: "Restart k3s-agent on omv-ha",
      description: `Restart the k3s-agent systemd service on omv-ha (Pi 4, 192.168.1.130).
Use when omv-ha shows NotReady in kubectl nodes, or when k3s-agent is stuck/crashed.
Waits 5 seconds and reports the new service state.
This does NOT re-register the node — use omv_ha_agent_rejoin for a full reinstall.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async () => {
      const cmd =
        "sudo systemctl restart k3s-agent" +
        " && sleep 5" +
        " && echo '=== k3s-agent post-restart ===' && systemctl is-active k3s-agent" +
        " && systemctl status k3s-agent --no-pager | tail -8";
      const r = await runOnNode("omv-ha", cmd);
      const text = r.error
        ? `❌ SSH to omv-ha failed: ${r.error}`
        : "```\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── omv_ha_agent_rejoin ───────────────────────────────────────────────────
  server.registerTool(
    "omv_ha_agent_rejoin",
    {
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
          .describe(
            "Set true to execute the full reinstall. Default false shows the steps as a dry run.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ run_commands }) => {
      let token: string;
      try {
        token = await fetchK3sToken();
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${String(e)}` }] };
      }

      const envFileContent = `K3S_URL=${K3S_URL}\nK3S_TOKEN=${token}\nGOGC=50`;

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
        `curl -sfL https://get.k3s.io | K3S_URL=${K3S_URL} K3S_TOKEN=<fetched from ${NODE_TOKEN_PATH}> sh -s - agent`,
        "",
        "# Step 4 — Write env file (preserves GOGC=50 GC tuning)",
        "sudo bash -c 'cat > /etc/systemd/system/k3s-agent.service.env << EOF",
        `K3S_URL=${K3S_URL}`,
        "K3S_TOKEN=<fetched from omv-main>",
        "GOGC=50",
        "EOF",
        "systemctl daemon-reload && systemctl start k3s-agent'",
        "```",
        "",
        "> Source: Runbook — omv-ha Demotion 2026-05-24",
        "> Token is read live from omv-main at runtime — not stored in source.",
        "> Set `run_commands=true` to execute.",
      ].join("\n");

      if (!run_commands) {
        return { content: [{ type: "text", text: preview }] };
      }

      const results: string[] = ["## omv-ha Agent Rejoin — Executing\n"];

      // Step 1: delete node object on omv-main
      results.push("### Step 1: Delete node from cluster");
      const del = await runOnNode(
        "omv-main",
        `${KUBECTL} delete node omv-ha --ignore-not-found`,
      );
      results.push(del.error ? `❌ ${del.error}` : "```\n" + del.stdout + "\n```");

      // Steps 2–4 on omv-ha: uninstall + reinstall + env file
      results.push("\n### Steps 2–4: Uninstall + reinstall on omv-ha");
      const installCmd = [
        "sudo /usr/local/bin/k3s-agent-uninstall.sh 2>/dev/null || true",
        `curl -sfL https://get.k3s.io | K3S_URL=${K3S_URL} K3S_TOKEN=${token} sh -s - agent`,
        `sudo bash -c 'printf "${envFileContent.replace(/\n/g, "\\n")}" > /etc/systemd/system/k3s-agent.service.env && systemctl daemon-reload && systemctl start k3s-agent'`,
      ].join(" && ");
      const install = await runOnNode("omv-ha", installCmd);
      results.push(install.error ? `❌ ${install.error}` : "```\n" + install.stdout + "\n```");

      // Verify
      results.push("\n### Verification (waiting 8s for agent to connect)");
      await new Promise((resolve) => setTimeout(resolve, 8000));
      const verify = await runOnNode("omv-main", `${KUBECTL} get nodes -o wide`);
      results.push(
        verify.error ? `❌ ${verify.error}` : "```\n" + verify.stdout + "\n```",
      );
      results.push(
        "\n> omv-ha should show `<none>` role and `Ready` status within ~30s.",
      );

      return { content: [{ type: "text", text: results.join("\n") }] };
    },
  );
}
