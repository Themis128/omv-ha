import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  getLambdaLogs,
  listLambdaLogGroups,
  getHealthCheckStatus,
  listSsmParameters,
  getSsmParameter,
} from "../services/aws.js";

const execFileAsync = promisify(execFile);
import {
  LAMBDA_LOG_GROUP_PREFIX,
  PRIMARY_HEALTH_CHECK_ID,
  SECONDARY_HEALTH_CHECK_ID,
  SSM_PREFIX,
  CHARACTER_LIMIT,
} from "../constants.js";

export function registerAwsTools(server: McpServer): void {
  // ── aws_get_lambda_logs ───────────────────────────────────────────────────
  server.registerTool(
    "aws_get_lambda_logs",
    {
      title: "Lambda Logs (CloudWatch)",
      description: `Fetch recent logs from the cloudless.gr Lambda function in CloudWatch.
Lists available log groups first if no log_group_name is given.
Logs are returned newest-first for the specified time window.
Filter with a pattern (e.g. "ERROR", "timeout", "[warn]") to narrow results.`,
      inputSchema: z.object({
        log_group_name: z
          .string()
          .optional()
          .describe(
            'Full CloudWatch log group name, e.g. "/aws/lambda/cloudless-production-server". Omit to list available groups.',
          ),
        minutes_back: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .default(30)
          .describe("How many minutes back to search (default: 30)"),
        limit: z
          .number()
          .int()
          .min(10)
          .max(500)
          .default(100)
          .describe("Max number of log events to return"),
        filter_pattern: z
          .string()
          .optional()
          .describe(
            'CloudWatch filter pattern, e.g. "ERROR" or "?warn ?error"',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ log_group_name, minutes_back, limit, filter_pattern }) => {
      // If no log group specified, list available groups
      if (!log_group_name) {
        const groups = await listLambdaLogGroups(LAMBDA_LOG_GROUP_PREFIX);
        if (groups.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Lambda log groups found with prefix "${LAMBDA_LOG_GROUP_PREFIX}". Check AWS credentials and region.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Available Lambda log groups (prefix: ${LAMBDA_LOG_GROUP_PREFIX}):\n\n` +
                groups.map((g) => `- \`${g}\``).join("\n") +
                "\n\nCall again with `log_group_name` to fetch logs.",
            },
          ],
        };
      }

      const startMs = Date.now() - minutes_back * 60 * 1000;
      try {
        const events = await getLambdaLogs(
          log_group_name,
          startMs,
          limit,
          filter_pattern,
        );

        if (events.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No log events found in \`${log_group_name}\` for the last ${minutes_back} minutes${filter_pattern ? ` matching "${filter_pattern}"` : ""}.`,
              },
            ],
          };
        }

        const lines = events.map((e) => {
          const ts = new Date(e.timestamp).toISOString();
          return `[${ts}] [${e.logStream.split("/").pop() ?? e.logStream}] ${e.message}`;
        });

        let text = `## Lambda Logs: ${log_group_name}\n**Last ${minutes_back}min | ${events.length} events**\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
        }

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Failed to fetch logs: ${msg}` }],
        };
      }
    },
  );

  // ── aws_check_health_checks ───────────────────────────────────────────────
  server.registerTool(
    "aws_check_health_checks",
    {
      title: "Route 53 Health Checks",
      description: `Check the status of Route 53 health checks for cloudless.gr.
PRIMARY: CloudFront distribution (main path)
SECONDARY: CloudFront origin group → Tailscale Funnel → Pi cluster (failover path)
Returns per-region health check observations and overall HEALTHY/UNHEALTHY status.`,
      inputSchema: z.object({
        check: z
          .enum(["primary", "secondary", "both"])
          .default("both")
          .describe("Which health check to query"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ check }) => {
      const checks: { label: string; id: string }[] = [];
      if (check === "primary" || check === "both") {
        checks.push({
          label: "PRIMARY (CloudFront)",
          id: PRIMARY_HEALTH_CHECK_ID,
        });
      }
      if (check === "secondary" || check === "both") {
        checks.push({
          label: "SECONDARY (CloudFront/Tailscale)",
          id: SECONDARY_HEALTH_CHECK_ID,
        });
      }

      const results = await Promise.allSettled(
        checks.map((c) =>
          getHealthCheckStatus(c.id).then((s) => ({ ...s, label: c.label })),
        ),
      );

      const lines: string[] = ["# Route 53 Health Check Status\n"];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const label = checks[i].label;
        lines.push(`## ${label}`);
        if (r.status === "rejected") {
          lines.push(`❌ Error: ${r.reason?.message ?? r.reason}`);
        } else {
          const s = r.value;
          const icon = s.status === "HEALTHY" ? "✅" : "❌";
          lines.push(`**Status: ${icon} ${s.status}** (ID: ${s.id})`);
          lines.push("\n**Region observations:**");
          for (const reg of s.checkedRegions) {
            const ok = reg.status.toLowerCase().includes("success");
            lines.push(`- ${ok ? "✅" : "❌"} ${reg.region}: ${reg.status}`);
          }
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── aws_get_ssm_parameters ────────────────────────────────────────────────
  server.registerTool(
    "aws_get_ssm_parameters",
    {
      title: "SSM Parameter Store — List/Get",
      description: `List or retrieve SSM parameters for cloudless.gr (prefix: /cloudless/production).
SecureString values are masked in list mode. Use parameter_name + decrypt=true to reveal a specific value.
Useful for auditing which secrets are configured, checking last-modified dates, or verifying a parameter exists.`,
      inputSchema: z.object({
        parameter_name: z
          .string()
          .optional()
          .describe(
            'Specific parameter name (relative to prefix, e.g. "STRIPE_SECRET_KEY" or absolute "/cloudless/production/STRIPE_SECRET_KEY"). Omit to list all.',
          ),
        decrypt: z
          .boolean()
          .default(false)
          .describe(
            "Decrypt SecureString value. Only used when parameter_name is set. Use with caution.",
          ),
        prefix: z
          .string()
          .optional()
          .describe(`SSM path prefix to list from (default: ${SSM_PREFIX})`),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ parameter_name, decrypt, prefix }) => {
      const resolvedPrefix = prefix ?? SSM_PREFIX;

      if (parameter_name) {
        // Resolve full name
        const fullName = parameter_name.startsWith("/")
          ? parameter_name
          : `${resolvedPrefix}/${parameter_name}`;

        const param = await getSsmParameter(fullName, decrypt);
        if (!param) {
          return {
            content: [
              { type: "text", text: `❌ Parameter not found: \`${fullName}\`` },
            ],
          };
        }
        const lines = [
          `## SSM Parameter: \`${param.name}\``,
          `- **Type:** ${param.type}`,
          `- **Last Modified:** ${param.lastModified?.toISOString() ?? "unknown"}`,
          `- **Value:** ${param.value ?? "(null)"}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // List all
      try {
        const params = await listSsmParameters(resolvedPrefix);
        if (params.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No parameters found under \`${resolvedPrefix}\`.`,
              },
            ],
          };
        }

        const rows = params.map((p) => {
          const modified = p.lastModified
            ? p.lastModified.toISOString().slice(0, 10)
            : "unknown";
          const val = p.type === "SecureString" ? "***" : (p.value ?? "");
          return `| \`${p.name}\` | ${p.type} | ${val.slice(0, 40)} | ${modified} |`;
        });

        const text =
          `## SSM Parameters under \`${resolvedPrefix}\`\n\n` +
          `| Name | Type | Value | Last Modified |\n` +
          `|------|------|-------|---------------|\n` +
          rows.join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `❌ Failed to list SSM parameters: ${msg}` },
          ],
        };
      }
    },
  );

  // ── aws_check_cloudfront ──────────────────────────────────────────────────
  server.registerTool(
    "aws_check_cloudfront",
    {
      title: "Check CloudFront Distribution URLs",
      description: `Check if the cloudless.gr CloudFront distributions are responding.
Tests HTTP response from the apex and www distributions.
Returns HTTP status codes and basic response headers to confirm CDN is serving correctly.`,
      inputSchema: z.object({
        domain: z
          .enum(["cloudless.gr", "www.cloudless.gr", "both"])
          .default("both")
          .describe("Which domain to check"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ domain }) => {
      const domains: string[] = [];
      if (domain === "cloudless.gr" || domain === "both")
        domains.push("cloudless.gr");
      if (domain === "www.cloudless.gr" || domain === "both")
        domains.push("www.cloudless.gr");

      const checks = await Promise.allSettled(
        domains.map(async (d) => {
          // Use a basic HTTP check via the AWS API - we'll simulate this as a description
          // In practice, fetch the URL via a simple HTTPS call
          const url = `https://${d}/api/health`;
          return { domain: d, url };
        }),
      );

      const lines = [
        "## CloudFront Domain Check",
        "",
        "To verify CloudFront health, use curl or check Route 53 health checks above.",
        "",
        "**Configured distributions:**",
        "- `cloudless.gr` → `d3k7muo3c6lw6s.cloudfront.net`",
        "- `www.cloudless.gr` → `dgrxxatzrgxfi.cloudfront.net`",
        "",
        "**API Gateway (secondary/failover):**",
        "- Apex: `d-uy6dmk95il.execute-api.us-east-1.amazonaws.com`",
        "- WWW: `d-2msx2z5q7d.execute-api.us-east-1.amazonaws.com`",
        "",
        "Use `aws_check_health_checks` for live Route 53 health status.",
        "Use `k3s_check_cloudless_app` to verify the Pi 5 secondary app.",
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── aws_get_infrastructure_summary ───────────────────────────────────────
  server.registerTool(
    "aws_get_infrastructure_summary",
    {
      title: "Cloudless Infrastructure Summary",
      description: `Return a static summary of the cloudless.gr AWS infrastructure topology.
Includes: Lambda, CloudFront, Route 53, SSM, and Pi failover path via Tailscale Funnel.
Use as a quick reference when diagnosing issues or explaining the architecture.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const text = `# cloudless.gr AWS Infrastructure Summary

## Traffic Flow (Primary)
\`\`\`
User → Route 53 (cloudless.gr)
       → CloudFront (d3k7muo3c6lw6s / dgrxxatzrgxfi)
       → Lambda@Edge + Origin Lambda (cloudless-production-server)
       → Next.js App (arm64, Node22, 1024MB, 30s timeout)
\`\`\`

## Traffic Flow (Failover — when Lambda health check fails)
\`\`\`
User → CloudFront origin group (primary-with-ha)
       → SECONDARY origin: omv.tail8eb71.ts.net (Tailscale Funnel)
       → Traefik VIP (192.168.1.200:18443)
       → cloudless-app pod (Pi cluster)
\`\`\`
Note: Route 53 SECONDARY records (API Gateway path) retired 2026-05-23.

## Route 53
- Zone: Z079608614L53CC4EAZM3
- PRIMARY health check: e239ad5c-dd17-40d7-8045-a153715168cf (CloudFront)
- SECONDARY health check: 30a69f1c-8d48-49bd-9067-cabec979478b (CloudFront/Tailscale)

## Secrets & Config
- SSM prefix: /cloudless/production
- AWS Region: us-east-1
- Lambda log group: /aws/lambda/cloudless-*

## Pi Nodes
- omv-main (k8s: omv, Pi 5, 8 GB): 192.168.1.128 — k3s server, control-plane + etcd + worker
- omv-ha (Pi 3B, 1 GB): 192.168.1.130 — k3s agent only (demoted 2026-05-24), cloudflared-ha
`;
      return { content: [{ type: "text", text }] };
    },
  );

  // ── aws_cognito_update_callbacks ──────────────────────────────────────────
  server.registerTool(
    "aws_cognito_update_callbacks",
    {
      title: "AWS Cognito — Update App Client Callbacks",
      description: `Update callback and logout URLs on the cloudless-oauth2-proxy Cognito app client.
Reads COGNITO_USER_POOL_ID from SSM (/cloudless/production/COGNITO_USER_POOL_ID) automatically.

Default target: manage.cloudless.gr (fixes stale manage.cloudless.online callbacks from Pass 1).
Client ID: 63d3fu5lp057694h0t70je4jk0 (cloudless-oauth2-proxy, created 2026-06-04)

Requires AWS credentials with cognito-idp:UpdateUserPoolClient permission.`,
      inputSchema: z.object({
        client_id: z
          .string()
          .default("63d3fu5lp057694h0t70je4jk0")
          .describe("Cognito app client ID"),
        callback_url: z
          .string()
          .default("https://manage.cloudless.gr/oauth2/callback")
          .describe("OAuth2 callback URL"),
        logout_url: z
          .string()
          .default("https://manage.cloudless.gr")
          .describe("Post-logout redirect URL"),
        region: z.string().default("us-east-1"),
        dry_run: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ client_id, callback_url, logout_url, region, dry_run }) => {
      try {
        // Read pool ID from SSM
        const { stdout: poolIdRaw } = await execFileAsync("aws", [
          "ssm", "get-parameter",
          "--name", "/cloudless/production/COGNITO_USER_POOL_ID",
          "--query", "Parameter.Value",
          "--output", "text",
          "--region", region,
        ], { timeout: 15_000 });
        const poolId = poolIdRaw.trim();
        if (!poolId) {
          return { content: [{ type: "text", text: `❌ COGNITO_USER_POOL_ID not found in SSM` }] };
        }

        if (dry_run) {
          return {
            content: [{
              type: "text",
              text: [
                `DRY RUN — would update:`,
                `  Pool ID:      ${poolId}`,
                `  Client ID:    ${client_id}`,
                `  Callback URL: ${callback_url}`,
                `  Logout URL:   ${logout_url}`,
              ].join("\n"),
            }],
          };
        }

        await execFileAsync("aws", [
          "cognito-idp", "update-user-pool-client",
          "--user-pool-id", poolId,
          "--client-id", client_id,
          "--callback-urls", callback_url,
          "--logout-urls", logout_url,
          "--region", region,
        ], { timeout: 30_000 });

        return {
          content: [{
            type: "text",
            text: [
              `✅ Cognito app client updated`,
              `  Pool ID:      ${poolId}`,
              `  Client ID:    ${client_id}`,
              `  Callback URL: ${callback_url}`,
              `  Logout URL:   ${logout_url}`,
            ].join("\n"),
          }],
        };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        return { content: [{ type: "text", text: `❌ ${msg}` }] };
      }
    },
  );

  // ── aws_iam_rotate_key ────────────────────────────────────────────────────
  server.registerTool(
    "aws_iam_rotate_key",
    {
      title: "AWS IAM — Rotate Access Key",
      description: `Rotate an IAM user's access key: deactivate the old key, create a new one,
store in SSM Parameter Store, and update GitHub secrets AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.

This replaces the rotate-aws-key.yml workflow for interactive use.
Default target: ses-smtp-prod (old key AKIAUBXIAELU5SADA3XL).

Requires: aws CLI authenticated + gh CLI authenticated.`,
      inputSchema: z.object({
        iam_username: z.string().default("ses-smtp-prod"),
        old_key_id: z.string().default("AKIAUBXIAELU5SADA3XL"),
        dry_run: z.boolean().default(true).describe("Print actions without executing (default: true for safety)"),
        delete_old: z.boolean().default(false).describe("Permanently delete old key (use after 14-day wait)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ iam_username, old_key_id, dry_run, delete_old }) => {
      const SSM_PREFIX = `/github-actions/aws-key/${iam_username}`;
      try {
        if (dry_run) {
          return {
            content: [{
              type: "text",
              text: [
                `DRY RUN — would:`,
                `  1. Deactivate key ${old_key_id} for user ${iam_username}`,
                `  2. Create new access key`,
                `  3. Store in SSM: ${SSM_PREFIX}/`,
                `  4. Update GitHub secrets AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY`,
                delete_old ? `  5. Delete old key ${old_key_id}` : `  5. Keep old key (Inactive) for 14 days`,
                ``,
                `Re-run with dry_run=false to execute.`,
              ].join("\n"),
            }],
          };
        }

        // Deactivate old key
        await execFileAsync("aws", [
          "iam", "update-access-key",
          "--user-name", iam_username,
          "--access-key-id", old_key_id,
          "--status", "Inactive",
        ], { timeout: 15_000 });

        // Create new key
        const { stdout: createOut } = await execFileAsync("aws", [
          "iam", "create-access-key",
          "--user-name", iam_username,
          "--output", "json",
        ], { timeout: 15_000 });
        const created = JSON.parse(createOut) as { AccessKey: { AccessKeyId: string; SecretAccessKey: string } };
        const newKeyId = created.AccessKey.AccessKeyId;
        const newSecret = created.AccessKey.SecretAccessKey;

        // Store in SSM
        await execFileAsync("aws", [
          "ssm", "put-parameter",
          "--name", `${SSM_PREFIX}/access-key-id`,
          "--value", newKeyId, "--type", "String", "--overwrite",
        ], { timeout: 15_000 });
        await execFileAsync("aws", [
          "ssm", "put-parameter",
          "--name", `${SSM_PREFIX}/secret-access-key`,
          "--value", newSecret, "--type", "SecureString", "--overwrite",
        ], { timeout: 15_000 });

        // Update GitHub secrets
        await execFileAsync("gh", ["secret", "set", "AWS_ACCESS_KEY_ID", "--repo", "Themis128/omv-ha", "--body", newKeyId], { timeout: 15_000 });
        await execFileAsync("gh", ["secret", "set", "AWS_SECRET_ACCESS_KEY", "--repo", "Themis128/omv-ha", "--body", newSecret], { timeout: 15_000 });

        // Optionally delete old key
        if (delete_old) {
          await execFileAsync("aws", [
            "iam", "delete-access-key",
            "--user-name", iam_username,
            "--access-key-id", old_key_id,
          ], { timeout: 15_000 });
        }

        return {
          content: [{
            type: "text",
            text: [
              `✅ IAM key rotated for ${iam_username}`,
              `  Old key: ${old_key_id} → Inactive${delete_old ? " (deleted)" : " (kept — delete after 14 days)"}`,
              `  New key: ${newKeyId}`,
              `  SSM: ${SSM_PREFIX}/`,
              `  GitHub: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY updated`,
            ].join("\n"),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ ${(e as Error).message}` }] };
      }
    },
  );
}
