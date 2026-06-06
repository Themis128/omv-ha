import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode, runOnBothNodes, nodeLabel } from "../services/ssh.js";
import {
  NodeName,
  CLOUDFRONT_DISTRIBUTION_ID,
  TAILSCALE_FUNNEL_HOST,
  K3S_TRAEFIK_VIP,
} from "../constants.js";

export function registerFailoverTools(server: McpServer): void {
  // ── failover_check_readiness ──────────────────────────────────────────────
  server.registerTool(
    "failover_check_readiness",
    {
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
    },
    async () => {
      const cmd =
        `echo "=== $(hostname) at $(date) ==="` +
        ` && echo '--- Disk ---' && df -h / /srv 2>/dev/null || df -h /` +
        ` && echo '--- Memory ---' && free -h | head -2` +
        ` && echo '--- Load ---' && uptime` +
        ` && echo '--- Samba ---' && systemctl is-active smbd 2>/dev/null && smbstatus -S 2>/dev/null | head -5 || echo '(samba not active or not available)'` +
        ` && echo '--- Network ---' && ip -4 addr show | grep 'inet ' | grep -v '127.0.0.1'` +
        ` && echo '--- IPv6 global ---' && ip -6 addr show | grep 'scope global' | awk '{print $2}' | cut -d/ -f1 || echo '(none)'`;

      const results = await runOnBothNodes(cmd);
      const lines: string[] = ["# Failover Readiness Report\n"];

      for (const [n, r] of Object.entries(results) as [
        NodeName,
        (typeof results)["omv-ha"],
      ][]) {
        lines.push(`## ${nodeLabel(n)}`);
        if (r.error) {
          lines.push(`❌ **UNREACHABLE**: ${r.error}`);
        } else {
          lines.push("```");
          lines.push(r.stdout || r.stderr);
          lines.push("```");
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── failover_check_shares ─────────────────────────────────────────────────
  server.registerTool(
    "failover_check_shares",
    {
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
    },
    async ({ node }) => {
      const cmd =
        `echo '=== Samba Services ===' && systemctl status smbd nmbd --no-pager -l | tail -8` +
        ` && echo '=== Configured Shares ===' && testparm -s 2>/dev/null | grep -E '^\[|path =' | head -30 || echo '(testparm not available)'` +
        ` && echo '=== Active Connections ===' && smbstatus 2>/dev/null | head -30 || echo '(no active connections)'`;

      const run = async (n: NodeName) => {
        const r = await runOnNode(n, cmd);
        return `## ${nodeLabel(n)}\n${r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```"}`;
      };

      let text: string;
      if (node === "both") {
        const [ha, main] = await Promise.all([run("omv-ha"), run("omv-main")]);
        text = [ha, main].join("\n\n");
      } else {
        text = await run(node);
      }

      return { content: [{ type: "text", text }] };
    },
  );

  // ── failover_sync_shares ──────────────────────────────────────────────────
  server.registerTool(
    "failover_sync_shares",
    {
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
          .describe(
            "Preview only — do not actually transfer files. ALWAYS set to true first.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ source_path, dest_path, dry_run }) => {
      const dryFlag = dry_run ? "--dry-run" : "";
      const cmd =
        `rsync -avz --progress ${dryFlag} ` +
        `-e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_ed25519" ` +
        `${source_path} tbaltzakis@192.168.1.130:${dest_path} 2>&1 | tail -50`;

      const r = await runOnNode("omv-main", cmd);
      const label = dry_run ? "🔍 DRY RUN" : "🚀 SYNC";
      const text = r.error
        ? `❌ rsync failed: ${r.error}`
        : `${label}: OMV main:${source_path} → OMV-HA:${dest_path}\n\`\`\`\n${r.stdout}\n\`\`\``;

      return { content: [{ type: "text", text }] };
    },
  );

  // ── failover_check_secondary_app ─────────────────────────────────────────
  server.registerTool(
    "failover_check_secondary_app",
    {
      title: "Check Cloudless k3s Failover Path (Tailscale Funnel)",
      description: `Verify the full HA failover chain for cloudless.gr (2026-05-23 architecture):
1. Tailscale Funnel active on omv.tail8eb71.ts.net → localhost:18443
2. k3s Traefik VIP (192.168.1.200:18443) health for Host: cloudless.gr and Host: omv.tail8eb71.ts.net
3. CloudFront secondary origin reachability check
4. k3s pod health in cloudless namespace
Use when CloudFront primary (Lambda/SST) is degraded and you need to confirm the k3s fallback is ready.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const cmd =
        `echo '=== Tailscale Funnel status ===' && tailscale funnel status 2>&1 | head -6` +
        ` && echo '=== k3s health [Host: cloudless.gr] ===' && curl -sk -o /dev/null -w "%{http_code}" --resolve "cloudless.gr:18443:${K3S_TRAEFIK_VIP}" -H "Host: cloudless.gr" https://${K3S_TRAEFIK_VIP}:18443/api/health 2>&1` +
        ` && echo '' && echo '=== k3s health [Host: ${TAILSCALE_FUNNEL_HOST}] ===' && curl -sk -o /dev/null -w "%{http_code}" --resolve "${TAILSCALE_FUNNEL_HOST}:18443:${K3S_TRAEFIK_VIP}" -H "Host: ${TAILSCALE_FUNNEL_HOST}" https://${K3S_TRAEFIK_VIP}:18443/api/health 2>&1` +
        ` && echo '' && echo '=== k3s ingress hosts ===' && kubectl get ingress cloudless -n cloudless -o jsonpath='{.spec.rules[*].host}' 2>&1` +
        ` && echo '' && echo '=== cloudless pods ===' && kubectl get pods -n cloudless -o wide 2>&1 | head -10` +
        ` && echo '=== cert status ===' && kubectl get certificate -n cloudless 2>&1`;

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ Cannot reach OMV main: ${r.error}`
        : "# k3s HA Failover Path Check\n\n```\n" + r.stdout + "\n```";

      return { content: [{ type: "text", text }] };
    },
  );

  // ── ha_check_cloudfront_failover ─────────────────────────────────────────
  server.registerTool(
    "ha_check_cloudfront_failover",
    {
      title: "Check CloudFront HA Origin Group Config",
      description: `Verify the CloudFront origin group failover configuration for cloudless.gr.
Checks:
- Distribution status (Deployed vs InProgress)
- Origins present (default + k3s-ha)
- OriginGroup primary-with-ha exists with correct failover codes
- DefaultCacheBehavior target is the origin group
- /api/* CacheBehavior points to primary only
- Route 53 PRIMARY health check status for cloudless.gr
Uses the AWS CLI on omv-main (omv-main-cli IAM user).`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const cmd =
        `echo '=== CloudFront distribution status ===' && aws cloudfront get-distribution --id ${CLOUDFRONT_DISTRIBUTION_ID} --query 'Distribution.Status' --output text` +
        ` && echo '=== Origins ===' && aws cloudfront get-distribution-config --id ${CLOUDFRONT_DISTRIBUTION_ID} --query 'DistributionConfig.Origins.Items[*].{Id:Id,Domain:DomainName}' --output table` +
        ` && echo '=== OriginGroups ===' && aws cloudfront get-distribution-config --id ${CLOUDFRONT_DISTRIBUTION_ID} --query 'DistributionConfig.OriginGroups' --output json` +
        ` && echo '=== DefaultCacheBehavior target + methods ===' && aws cloudfront get-distribution-config --id ${CLOUDFRONT_DISTRIBUTION_ID} --query 'DistributionConfig.DefaultCacheBehavior.{Target:TargetOriginId,Methods:AllowedMethods.Items}' --output json` +
        ` && echo '=== CacheBehaviors ===' && aws cloudfront get-distribution-config --id ${CLOUDFRONT_DISTRIBUTION_ID} --query 'DistributionConfig.CacheBehaviors.Items[*].{Path:PathPattern,Target:TargetOriginId,Methods:AllowedMethods.Quantity}' --output table` +
        ` && echo '=== R53 PRIMARY health check ===' && aws route53 get-health-check-status --health-check-id e239ad5c-dd17-40d7-8045-a153715168cf --query 'HealthCheckObservations[*].{Region:Region,Status:StatusReport.Status}' --output table 2>&1 | head -20`;

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ Cannot reach OMV main: ${r.error}`
        : "# CloudFront HA Failover Config\n\n```\n" + r.stdout + "\n```";

      return { content: [{ type: "text", text }] };
    },
  );

  // ── ha_test_k3s_origin ────────────────────────────────────────────────────
  server.registerTool(
    "ha_test_k3s_origin",
    {
      title: "Test k3s as CloudFront Secondary Origin",
      description: `End-to-end test of the k3s failover origin as CloudFront would reach it.
Tests both host headers that k3s must accept:
- Host: cloudless.gr (normal traffic, Cloudflare Tunnel path)
- Host: omv.tail8eb71.ts.net (CloudFront secondary origin host)
Also tests a GET and a redirect (/) to simulate real page load failover.
All curls go directly to 192.168.1.200:18443 (k3s Traefik MetalLB VIP).`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const vip = K3S_TRAEFIK_VIP;
      const funnel = TAILSCALE_FUNNEL_HOST;
      const cmd =
        `echo '--- /api/health [Host: cloudless.gr] ---' && curl -sk -o /dev/null -w "HTTP %{http_code}\\n" --resolve "cloudless.gr:18443:${vip}" -H "Host: cloudless.gr" https://${vip}:18443/api/health` +
        ` && echo '--- / [Host: cloudless.gr] ---' && curl -sk -o /dev/null -w "HTTP %{http_code}\\n" --resolve "cloudless.gr:18443:${vip}" -H "Host: cloudless.gr" https://${vip}:18443/` +
        ` && echo '--- /api/health [Host: ${funnel}] ---' && curl -sk -o /dev/null -w "HTTP %{http_code}\\n" --resolve "${funnel}:18443:${vip}" -H "Host: ${funnel}" https://${vip}:18443/api/health` +
        ` && echo '--- / [Host: ${funnel}] ---' && curl -sk -o /dev/null -w "HTTP %{http_code}\\n" --resolve "${funnel}:18443:${vip}" -H "Host: ${funnel}" https://${vip}:18443/` +
        ` && echo '--- /api/health [Host: www.cloudless.gr] ---' && curl -sk -o /dev/null -w "HTTP %{http_code}\\n" --resolve "www.cloudless.gr:18443:${vip}" -H "Host: www.cloudless.gr" https://${vip}:18443/api/health`;

      const r = await runOnNode("omv-main", cmd);
      const body = r.error ? `❌ SSH error: ${r.error}` : r.stdout.trim();

      const expected = "Expected: /api/health → 200, / → 307 (locale redirect)";
      const text = `# k3s Origin Test Results\n\n${expected}\n\n\`\`\`\n${body}\n\`\`\``;
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ha_cleanup_cloudless_online ───────────────────────────────────────────
  server.registerTool(
    "ha_cleanup_cloudless_online",
    {
      title: "Clean Up cloudless.gr Artifacts",
      description: `Remove remaining cloudless.gr references from the k3s cluster.
Actions taken:
- Deletes the cloudless-gr-tls Certificate resource in the cloudless namespace
- Deletes the cloudless-gr-tls Secret in the cloudless namespace
- Reports any remaining cloudless.gr references in manifests
Does NOT touch Cloudflare DNS records (use cloudflare_delete_dns_record for those).
Does NOT touch Route 53 health check 30a69f1c (needs console — no CLI permission).
SAFE to run multiple times (idempotent).`,
      inputSchema: z.object({
        dry_run: z
          .boolean()
          .default(true)
          .describe("Preview only — do not delete anything. Default: true"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ dry_run }) => {
      const checkCmd =
        `echo '=== cloudless-gr-tls certificate ===' && kubectl get certificate cloudless-gr-tls -n cloudless 2>&1` +
        ` && echo '=== cloudless-gr-tls secret ===' && kubectl get secret cloudless-gr-tls -n cloudless 2>&1` +
        ` && echo '=== remaining .online references in ingress/configmaps ===' && kubectl get ingress,configmap -n cloudless -o yaml 2>&1 | grep 'cloudless.gr' | head -10 || echo '(none found)'`;

      const deleteCmd =
        `kubectl delete certificate cloudless-gr-tls -n cloudless 2>&1 || echo '(certificate already gone)'` +
        ` && kubectl delete secret cloudless-gr-tls -n cloudless 2>&1 || echo '(secret already gone)'` +
        ` && echo '✅ Deleted cloudless-gr-tls certificate and secret'` +
        ` && echo '=== Remaining references ===' && kubectl get all,ingress,certificate -n cloudless -o yaml 2>&1 | grep 'cloudless.gr' | head -10 || echo '(none remaining)'`;

      if (dry_run) {
        const r = await runOnNode("omv-main", checkCmd);
        const body = r.error ? `❌ SSH error: ${r.error}` : r.stdout.trim();
        return {
          content: [
            {
              type: "text",
              text: `# cloudless.gr Cleanup — DRY RUN\n\nRun with \`dry_run: false\` to actually delete.\n\n\`\`\`\n${body}\n\`\`\`\n\n**Remaining manual steps:**\n- Delete R53 health check \`30a69f1c\` via AWS console (no CLI permission)\n- Delete Cloudflare DNS records for cloudless.gr zone via \`cloudflare_delete_dns_record\``,
            },
          ],
        };
      }

      const r = await runOnNode("omv-main", deleteCmd);
      const body = r.error ? `❌ SSH error: ${r.error}` : r.stdout.trim();
      return {
        content: [
          {
            type: "text",
            text: `# cloudless.gr Cleanup — EXECUTED\n\n\`\`\`\n${body}\n\`\`\`\n\n**Remaining manual steps:**\n- Delete R53 health check \`30a69f1c\` via AWS console\n- Delete Cloudflare DNS records for cloudless.gr zone via \`cloudflare_delete_dns_record\``,
          },
        ],
      };
    },
  );

  // ── failover_network_check ────────────────────────────────────────────────
  server.registerTool(
    "failover_network_check",
    {
      title: "Network Connectivity Check Between Nodes",
      description: `Check network connectivity between both Pi nodes and to the internet.
Tests: ping between nodes, DNS resolution, internet connectivity, and IPv6 status.
Useful for diagnosing failover issues caused by network problems.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const haCmd =
        `echo '=== OMV-HA network check ===' && hostname -I` +
        ` && echo '--- Ping OMV main ---' && ping -c 2 -W 2 192.168.1.128 2>&1 | tail -3` +
        ` && echo '--- DNS ---' && nslookup cloudless.gr 2>&1 | tail -5` +
        ` && echo '--- Internet ---' && ping -c 2 -W 2 8.8.8.8 2>&1 | tail -3`;

      const mainCmd =
        `echo '=== OMV main network check ===' && hostname -I` +
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
    },
  );
}
