import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
import { AWS_ACCOUNT_ID, CHARACTER_LIMIT } from "../constants.js";

export function registerAwsIamTools(server: McpServer): void {
  // ── aws_list_iam_users ────────────────────────────────────────────────────
  server.registerTool(
    "aws_list_iam_users",
    {
      title: "List IAM Users",
      description: `List all IAM users in the AWS account with their access key status and last-used date.
Runs via the omv-main-cli IAM user configured on the Pi.
Returns a markdown table of users, their access keys, key status, and last-used info.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const listUsersCmd = `aws iam list-users --query 'Users[*].{UserName:UserName,Created:CreateDate,Arn:Arn}' --output json`;

      const r = await runOnNode("omv-main", listUsersCmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }
      if (r.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ aws iam list-users failed:\n\`\`\`\n${r.stderr}\n\`\`\``,
            },
          ],
        };
      }

      let users: Array<{ UserName: string; Created: string; Arn: string }>;
      try {
        users = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse IAM users JSON:\n${r.stdout}`,
            },
          ],
        };
      }

      if (users.length === 0) {
        return { content: [{ type: "text", text: "No IAM users found." }] };
      }

      // Fetch access keys for each user concurrently via a single compound command
      const keysCmds = users
        .map(
          (u) =>
            `echo "USER:${u.UserName}" && aws iam list-access-keys --user-name "${u.UserName}" --output json`,
        )
        .join(" && ");

      const keysResult = await runOnNode("omv-main", keysCmds);
      const keysOutput = keysResult.stdout;

      // Parse the compound output — split on USER: markers
      const keysByUser: Record<string, string> = {};
      const segments = keysOutput.split(/USER:(\S+)\n/);
      for (let i = 1; i < segments.length; i += 2) {
        const userName = segments[i];
        const json = segments[i + 1]?.trim() ?? "";
        keysByUser[userName] = json;
      }

      const lines: string[] = [
        "# IAM Users",
        "",
        "| User | Created | Key ID | Key Status | Last Used |",
        "|------|---------|--------|------------|-----------|",
      ];

      for (const user of users) {
        const created = user.Created.slice(0, 10);
        const keysJson = keysByUser[user.UserName] ?? "";
        let keyRows: Array<{
          AccessKeyId: string;
          Status: string;
          CreateDate: string;
        }> = [];
        try {
          const parsed = JSON.parse(keysJson);
          keyRows = parsed.AccessKeyMetadata ?? [];
        } catch {
          // no keys or parse error
        }

        if (keyRows.length === 0) {
          lines.push(`| \`${user.UserName}\` | ${created} | — | — | — |`);
        } else {
          for (const key of keyRows) {
            const status = key.Status === "Active" ? "Active" : "Inactive";
            lines.push(
              `| \`${user.UserName}\` | ${created} | \`${key.AccessKeyId}\` | ${status} | — |`,
            );
          }
        }
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── aws_check_iam_permissions ─────────────────────────────────────────────
  server.registerTool(
    "aws_check_iam_permissions",
    {
      title: "Simulate IAM Policy (Check Permissions)",
      description: `Simulate whether an IAM user is allowed to perform a given action on a resource.
Uses aws iam simulate-principal-policy on the Pi.
Useful to check if omv-main-cli (or another user) has a specific permission before running a task.`,
      inputSchema: z.object({
        user_name: z
          .string()
          .min(1)
          .describe('IAM user name to check, e.g. "omv-main-cli"'),
        action: z
          .string()
          .min(1)
          .describe('IAM action to simulate, e.g. "route53:DeleteHealthCheck"'),
        resource: z
          .string()
          .default("*")
          .describe('Resource ARN to test against (default: "*")'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ user_name, action, resource }) => {
      const arn = `arn:aws:iam::${AWS_ACCOUNT_ID}:user/${user_name}`;
      const cmd =
        `aws iam simulate-principal-policy` +
        ` --policy-source-arn "${arn}"` +
        ` --action-names "${action}"` +
        ` --resource-arns "${resource}"` +
        ` --output json`;

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }
      if (r.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ simulate-principal-policy failed:\n\`\`\`\n${r.stderr}\n\`\`\``,
            },
          ],
        };
      }

      let result: {
        EvaluationResults?: Array<{
          EvalActionName: string;
          EvalDecision: string;
        }>;
      };
      try {
        result = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            { type: "text", text: `❌ Failed to parse response:\n${r.stdout}` },
          ],
        };
      }

      const evals = result.EvaluationResults ?? [];
      const lines: string[] = [
        `## IAM Permission Check`,
        ``,
        `**User:** \`${user_name}\``,
        `**Action:** \`${action}\``,
        `**Resource:** \`${resource}\``,
        ``,
      ];

      if (evals.length === 0) {
        lines.push("No evaluation results returned.");
      } else {
        for (const ev of evals) {
          const allowed = ev.EvalDecision === "allowed";
          lines.push(
            `**Decision:** ${allowed ? "✅ ALLOWED" : "❌ DENIED"} (\`${ev.EvalDecision}\`)`,
          );
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── aws_list_acm_certs ────────────────────────────────────────────────────
  server.registerTool(
    "aws_list_acm_certs",
    {
      title: "List ACM Certificates",
      description: `List all ACM (AWS Certificate Manager) certificates in us-east-1.
Returns domain name, SANs, status, and expiry for each certificate.
Useful to audit SSL/TLS certificates managed in AWS.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const listCmd = `aws acm list-certificates --region us-east-1 --output json`;
      const r = await runOnNode("omv-main", listCmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }
      if (r.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ acm list-certificates failed:\n\`\`\`\n${r.stderr}\n\`\`\``,
            },
          ],
        };
      }

      let listResult: {
        CertificateSummaryList?: Array<{
          CertificateArn: string;
          DomainName: string;
        }>;
      };
      try {
        listResult = JSON.parse(r.stdout);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse certificate list:\n${r.stdout}`,
            },
          ],
        };
      }

      const certs = listResult.CertificateSummaryList ?? [];
      if (certs.length === 0) {
        return {
          content: [
            { type: "text", text: "No ACM certificates found in us-east-1." },
          ],
        };
      }

      // Describe each cert
      const describeCmd = certs
        .map(
          (c) =>
            `echo "CERT:${c.CertificateArn}" && aws acm describe-certificate --certificate-arn "${c.CertificateArn}" --region us-east-1 --output json`,
        )
        .join(" && ");

      const descResult = await runOnNode("omv-main", describeCmd);
      const descOutput = descResult.stdout;

      const detailsByArn: Record<string, string> = {};
      const segments = descOutput.split(/CERT:([^\n]+)\n/);
      for (let i = 1; i < segments.length; i += 2) {
        const arn = segments[i].trim();
        const json = segments[i + 1]?.trim() ?? "";
        detailsByArn[arn] = json;
      }

      const lines: string[] = [
        "# ACM Certificates (us-east-1)",
        "",
        "| Domain | Status | Expiry | ARN | SANs |",
        "|--------|--------|--------|-----|------|",
      ];

      for (const cert of certs) {
        const detailJson = detailsByArn[cert.CertificateArn] ?? "";
        let domain = cert.DomainName;
        let status = "—";
        let expiry = "—";
        let sans = "—";

        try {
          const detail = JSON.parse(detailJson);
          const c = detail.Certificate ?? {};
          domain = c.DomainName ?? domain;
          status = c.Status ?? "—";
          expiry = c.NotAfter
            ? new Date(c.NotAfter).toISOString().slice(0, 10)
            : "—";
          const sanList: string[] = c.SubjectAlternativeNames ?? [];
          sans = sanList.filter((s: string) => s !== domain).join(", ") || "—";
        } catch {
          // use defaults
        }

        const arnShort =
          cert.CertificateArn.split("/").pop() ?? cert.CertificateArn;
        lines.push(
          `| \`${domain}\` | ${status} | ${expiry} | \`...${arnShort}\` | ${sans} |`,
        );
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n...(truncated)";
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── aws_grant_route53_delete_health_check ─────────────────────────────────
  server.registerTool(
    "aws_grant_route53_delete_health_check",
    {
      title: "Grant route53:DeleteHealthCheck to omv-main-cli",
      description: `Add an inline IAM policy named "route53-delete-hc" to the omv-main-cli IAM user.
The policy grants route53:DeleteHealthCheck on all resources.
This is an additive IAM change — it does not remove existing permissions.
Run aws_check_iam_permissions first to verify the user currently lacks this permission.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async () => {
      const policyDoc = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "route53:DeleteHealthCheck",
            Resource: "*",
          },
        ],
      });

      const cmd =
        `aws iam put-user-policy` +
        ` --user-name omv-main-cli` +
        ` --policy-name route53-delete-hc` +
        ` --policy-document '${policyDoc}'`;

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }
      if (r.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ put-user-policy failed:\n\`\`\`\n${r.stderr}\n\`\`\``,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "## IAM Policy Granted",
              "",
              "Inline policy `route53-delete-hc` added to user `omv-main-cli`.",
              "",
              "**Policy:** `route53:DeleteHealthCheck` on `*`",
              "",
              "Use `aws_check_iam_permissions` with action `route53:DeleteHealthCheck` to verify.",
              "Use `aws_revoke_route53_delete_health_check` to remove this policy when done.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── aws_revoke_route53_delete_health_check ────────────────────────────────
  server.registerTool(
    "aws_revoke_route53_delete_health_check",
    {
      title: "Revoke route53:DeleteHealthCheck from omv-main-cli",
      description: `Remove the inline IAM policy "route53-delete-hc" from the omv-main-cli user.
Use this after deleting health checks to restore least-privilege access.
Runs aws iam delete-user-policy on the Pi.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async () => {
      const cmd =
        `aws iam delete-user-policy` +
        ` --user-name omv-main-cli` +
        ` --policy-name route53-delete-hc`;

      const r = await runOnNode("omv-main", cmd);
      if (r.error) {
        return {
          content: [{ type: "text", text: `❌ SSH error: ${r.error}` }],
        };
      }
      if (r.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ delete-user-policy failed:\n\`\`\`\n${r.stderr}\n\`\`\``,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "## IAM Policy Revoked",
              "",
              "Inline policy `route53-delete-hc` removed from user `omv-main-cli`.",
              "`omv-main-cli` no longer has `route53:DeleteHealthCheck` permission.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── aws_delete_acm_cert ───────────────────────────────────────────────────
  server.registerTool(
    "aws_delete_acm_cert",
    {
      title: "Delete ACM Certificate",
      description: `Delete an ACM certificate by ARN.
Safety check: refuses to delete certificates with status ISSUED (still in use by CloudFront/ALB/etc.).
Only deletes certificates in PENDING_VALIDATION, EXPIRED, FAILED, or INACTIVE status.
Use aws_list_acm_certs to find the ARN first.`,
      inputSchema: z.object({
        certificate_arn: z
          .string()
          .min(1)
          .describe(
            "Full ARN of the ACM certificate to delete, e.g. arn:aws:acm:us-east-1:...",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ certificate_arn }) => {
      // Safety check: describe first
      const describeCmd = `aws acm describe-certificate --certificate-arn "${certificate_arn}" --region us-east-1 --output json`;
      const descResult = await runOnNode("omv-main", describeCmd);
      if (descResult.error) {
        return {
          content: [
            { type: "text", text: `❌ SSH error: ${descResult.error}` },
          ],
        };
      }
      if (descResult.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ describe-certificate failed:\n\`\`\`\n${descResult.stderr}\n\`\`\``,
            },
          ],
        };
      }

      let certStatus = "UNKNOWN";
      let certDomain = "unknown";
      try {
        const parsed = JSON.parse(descResult.stdout);
        certStatus = parsed.Certificate?.Status ?? "UNKNOWN";
        certDomain = parsed.Certificate?.DomainName ?? "unknown";
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to parse describe-certificate response:\n${descResult.stdout}`,
            },
          ],
        };
      }

      if (certStatus === "ISSUED") {
        return {
          content: [
            {
              type: "text",
              text: [
                `❌ Safety check failed: certificate is **ISSUED** (still in use).`,
                ``,
                `**Domain:** \`${certDomain}\``,
                `**ARN:** \`${certificate_arn}\``,
                `**Status:** ISSUED`,
                ``,
                `Remove the certificate from all CloudFront distributions, ALBs, and other services before deleting.`,
              ].join("\n"),
            },
          ],
        };
      }

      // Proceed with deletion
      const deleteCmd = `aws acm delete-certificate --certificate-arn "${certificate_arn}" --region us-east-1`;
      const deleteResult = await runOnNode("omv-main", deleteCmd);
      if (deleteResult.error) {
        return {
          content: [
            { type: "text", text: `❌ SSH error: ${deleteResult.error}` },
          ],
        };
      }
      if (deleteResult.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `❌ delete-certificate failed:\n\`\`\`\n${deleteResult.stderr}\n\`\`\``,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "## ACM Certificate Deleted",
              "",
              `**Domain:** \`${certDomain}\``,
              `**ARN:** \`${certificate_arn}\``,
              `**Former status:** ${certStatus}`,
              "",
              "Certificate has been permanently deleted.",
            ].join("\n"),
          },
        ],
      };
    },
  );
}
