import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode } from "../services/ssh.js";

const KUBECTL = "sudo k3s kubectl";
const NS = "analytics";
const MB_DEPLOY = "deployment/metabase";
const DUCKDB_DEPLOY = "deployment/duckdb-api";
const H2_URL = "jdbc:h2:/metabase-data/metabase.db/metabase.db";
const MB_IMAGE = "metabase-debian:v0.55";
const MB_URL = "http://localhost:3000";

export function registerMetabaseTools(server: McpServer): void {
  // ── metabase_check_health ─────────────────────────────────────────────────
  server.registerTool(
    "metabase_check_health",
    {
      title: "Metabase Health Check",
      description: `Check Metabase pod status and optionally verify login.
Returns pod state, restart count, readiness, and API health endpoint response.
Note: Metabase takes ~4.5 minutes to become ready after startup (initialDelaySeconds=240).`,
      inputSchema: z.object({
        verify_login: z
          .boolean()
          .default(false)
          .describe("Also attempt a login with the admin credentials to verify auth works"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ verify_login }) => {
      let cmd =
        `${KUBECTL} get pods -n ${NS} -o wide` +
        ` && echo '--- Metabase deployment ---'` +
        ` && ${KUBECTL} get deployment metabase -n ${NS}` +
        ` && echo '--- duckdb-api deployment ---'` +
        ` && ${KUBECTL} get deployment duckdb-api -n ${NS}`;

      if (verify_login) {
        cmd +=
          ` && echo '--- Login test ---'` +
          ` && ${KUBECTL} exec -n ${NS} deployment/metabase -- ` +
          `curl -s -X POST ${MB_URL}/api/session ` +
          `-H 'Content-Type: application/json' ` +
          `-d '{"username":"tbaltzakis@cloudless.gr","password":"TH!123789th!"}'`;
      }

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```\n" + r.stdout + (r.stderr ? "\nSTDERR:\n" + r.stderr : "") + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── metabase_h2_query ─────────────────────────────────────────────────────
  server.registerTool(
    "metabase_h2_query",
    {
      title: "Metabase H2 SQL Query",
      description: `Run a SQL query against the Metabase H2 embedded database.
IMPORTANT: Metabase MUST be scaled to 0 before running — the H2 database cannot be accessed by two JVM processes simultaneously.
This tool scales Metabase down, runs the query, then scales it back up.

H2 facts:
- DB path: /metabase-data/metabase.db/metabase.db (inside subdirectory)
- Admin user: "" (empty string, no password)
- Classpath: /app/metabase.jar (uberjar with H2 merged in)

Example queries:
  SELECT id, email, is_superuser, is_active FROM core_user;
  SELECT id, name, engine FROM metabase_database;`,
      inputSchema: z.object({
        sql: z.string().describe("SQL query to execute against the H2 database"),
        scale_down_first: z
          .boolean()
          .default(true)
          .describe("Scale Metabase to 0 before querying (required for write operations, safe for reads too)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sql, scale_down_first }) => {
      const lines: string[] = [];

      if (scale_down_first) {
        lines.push("=== Scaling Metabase to 0 ===");
        const scaleDown = await runOnNode(
          "omv-main",
          `${KUBECTL} scale ${MB_DEPLOY} -n ${NS} --replicas=0 && ` +
            `${KUBECTL} wait --for=delete pod -l app=metabase -n ${NS} --timeout=60s 2>/dev/null || true`,
        );
        lines.push(scaleDown.stdout || scaleDown.error || "done");
      }

      lines.push("=== Running H2 query ===");
      // Escape single quotes in SQL by ending string, inserting escaped quote, resuming
      const escapedSql = sql.replace(/'/g, "'\\''");
      const queryCmd =
        `${KUBECTL} run metabase-h2-query-$RANDOM --rm -i --restart=Never ` +
        `-n ${NS} ` +
        `--image=${MB_IMAGE} --image-pull-policy=IfNotPresent ` +
        `--overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"omv"},"volumes":[{"name":"metabase-data","persistentVolumeClaim":{"claimName":"metabase-data"}}],"containers":[{"name":"h2","image":"${MB_IMAGE}","imagePullPolicy":"IfNotPresent","command":["/bin/bash","-c","java -cp /app/metabase.jar org.h2.tools.Shell -url \\"jdbc:h2:/metabase-data/metabase.db/metabase.db\\" -user \\"\\" -password \\"\\" -sql \\"${escapedSql}\\""],"volumeMounts":[{"name":"metabase-data","mountPath":"/metabase-data"}]}]}}' ` +
        `-- /bin/bash -c 'java -cp /app/metabase.jar org.h2.tools.Shell -url "${H2_URL}" -user "" -password "" -sql "${escapedSql}"'`;

      // Simpler approach: use exec on a temporary job-style pod via kubectl exec on a running pod
      // Actually, use a Job via apply since kubectl run --overrides is complex with SSH escaping
      // Use a direct SSH approach instead: exec into the PVC via a simple run command
      const simpleQuery = `${KUBECTL} run metabase-h2-q --rm -i --restart=Never -n ${NS} ` +
        `--image=${MB_IMAGE} --image-pull-policy=IfNotPresent ` +
        `--overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"omv"},"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"metabase-data"}}],"containers":[{"name":"h","image":"${MB_IMAGE}","imagePullPolicy":"IfNotPresent","command":["java","-cp","/app/metabase.jar","org.h2.tools.Shell","-url","${H2_URL}","-user","","-password","","-sql","${escapedSql}"],"volumeMounts":[{"name":"d","mountPath":"/metabase-data"}]}]}}' ` +
        `-- /bin/true 2>&1 || true`;

      const qr = await runOnNode("omv-main", simpleQuery);
      lines.push(qr.stdout || "");
      if (qr.stderr) lines.push("STDERR: " + qr.stderr);
      if (qr.error) lines.push("ERROR: " + qr.error);

      if (scale_down_first) {
        lines.push("=== Scaling Metabase back to 1 ===");
        const scaleUp = await runOnNode(
          "omv-main",
          `${KUBECTL} scale ${MB_DEPLOY} -n ${NS} --replicas=1`,
        );
        lines.push(scaleUp.stdout || scaleUp.error || "done");
        lines.push("Note: Metabase takes ~4.5 minutes to become ready (initialDelaySeconds=240)");
      }

      return { content: [{ type: "text", text: "```\n" + lines.join("\n") + "\n```" }] };
    },
  );

  // ── metabase_reset_password ───────────────────────────────────────────────
  server.registerTool(
    "metabase_reset_password",
    {
      title: "Metabase Admin Password Reset",
      description: `Reset the Metabase admin password via H2 direct database update.
Procedure: scale to 0 → apply H2 reset job → verify → scale back to 1.

The hash must be a bcrypt hash using $2a$ prefix (NOT $2b$) — jBCrypt in Metabase v0.55 rejects $2b$.
Generate via Python:
  import bcrypt, uuid
  salt = str(uuid.uuid4())
  pw = "your_password"
  hashed = bcrypt.hashpw((salt + pw).encode(), bcrypt.gensalt(10, prefix=b'2a')).decode()

Admin email: tbaltzakis@cloudless.gr
Standard password: TH!123789th!`,
      inputSchema: z.object({
        email: z
          .string()
          .default("tbaltzakis@cloudless.gr")
          .describe("Admin email address to set"),
        bcrypt_hash: z
          .string()
          .describe("bcrypt hash with $2a$ prefix (e.g. $2a$10$...)"),
        password_salt: z
          .string()
          .describe("UUID used as salt prefix when generating the hash"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ email, bcrypt_hash, password_salt }) => {
      const lines: string[] = [];

      // Validate hash prefix
      if (!bcrypt_hash.startsWith("$2a$")) {
        return {
          content: [{
            type: "text",
            text: "❌ Hash must use $2a$ prefix (not $2b$). jBCrypt in Metabase v0.55 rejects $2b$ hashes. Regenerate with: bcrypt.gensalt(10, prefix=b'2a')",
          }],
        };
      }

      lines.push("=== Step 1: Scale Metabase to 0 ===");
      const scaleDown = await runOnNode(
        "omv-main",
        `${KUBECTL} scale ${MB_DEPLOY} -n ${NS} --replicas=0 && ` +
          `${KUBECTL} wait --for=delete pod -l app=metabase -n ${NS} --timeout=60s 2>/dev/null || true`,
      );
      lines.push(scaleDown.stdout || scaleDown.error || "done");

      lines.push("\n=== Step 2: Apply H2 password reset ===");
      // Build the job manifest inline and pipe to kubectl apply
      const jobName = "metabase-h2-reset";
      const jobManifest = JSON.stringify({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: jobName, namespace: NS },
        spec: {
          ttlSecondsAfterFinished: 120,
          template: {
            spec: {
              nodeSelector: { "kubernetes.io/hostname": "omv" },
              restartPolicy: "Never",
              containers: [{
                name: "h2-reset",
                image: MB_IMAGE,
                imagePullPolicy: "IfNotPresent",
                command: ["/bin/bash", "-c"],
                args: [
                  `set -e\n` +
                  `HASH='${bcrypt_hash}'\n` +
                  `SALT='${password_salt}'\n` +
                  `EMAIL='${email}'\n` +
                  `SQL="UPDATE core_user SET email='\${EMAIL}', password='\${HASH}', password_salt='\${SALT}', is_active=true WHERE id=1;"\n` +
                  `echo '=== BEFORE ==='\n` +
                  `java -cp /app/metabase.jar org.h2.tools.Shell -url "${H2_URL}" -user "" -password "" -sql "SELECT id, email, password_salt FROM core_user WHERE id=1;"\n` +
                  `echo '=== UPDATING ==='\n` +
                  `java -cp /app/metabase.jar org.h2.tools.Shell -url "${H2_URL}" -user "" -password "" -sql "\$SQL"\n` +
                  `echo '=== AFTER ==='\n` +
                  `java -cp /app/metabase.jar org.h2.tools.Shell -url "${H2_URL}" -user "" -password "" -sql "SELECT id, email, password_salt FROM core_user WHERE id=1;"\n` +
                  `echo '=== DONE ==='`,
                ],
                volumeMounts: [{ name: "metabase-data", mountPath: "/metabase-data" }],
              }],
              volumes: [{
                name: "metabase-data",
                persistentVolumeClaim: { claimName: "metabase-data" },
              }],
            },
          },
        },
      });

      // Delete old job if exists, then apply new one
      await runOnNode("omv-main", `${KUBECTL} delete job ${jobName} -n ${NS} 2>/dev/null || true`);
      const applyCmd = `echo '${jobManifest.replace(/'/g, "'\\''")}' | ${KUBECTL} apply -f -`;
      const applyResult = await runOnNode("omv-main", applyCmd);
      lines.push(applyResult.stdout || applyResult.error || "applied");

      // Wait for job to complete
      lines.push("\n=== Waiting for job completion (up to 120s) ===");
      const waitResult = await runOnNode(
        "omv-main",
        `${KUBECTL} wait job/${jobName} -n ${NS} --for=condition=complete --timeout=120s 2>&1 || ` +
          `${KUBECTL} wait job/${jobName} -n ${NS} --for=condition=failed --timeout=5s 2>&1 || true`,
      );
      lines.push(waitResult.stdout || waitResult.error || "");

      // Get job logs
      lines.push("\n=== Job logs ===");
      const logsResult = await runOnNode(
        "omv-main",
        `${KUBECTL} logs job/${jobName} -n ${NS} 2>&1 || true`,
      );
      lines.push(logsResult.stdout || logsResult.error || "(no logs yet)");

      // Scale back up
      lines.push("\n=== Step 3: Scale Metabase back to 1 ===");
      const scaleUp = await runOnNode(
        "omv-main",
        `${KUBECTL} scale ${MB_DEPLOY} -n ${NS} --replicas=1`,
      );
      lines.push(scaleUp.stdout || scaleUp.error || "done");
      lines.push("Metabase will be ready in ~4.5 minutes (initialDelaySeconds=240).");
      lines.push(`To verify login once ready, use metabase_check_health with verify_login=true.`);

      return { content: [{ type: "text", text: "```\n" + lines.join("\n") + "\n```" }] };
    },
  );

  // ── metabase_duckdb_lock_fix ──────────────────────────────────────────────
  server.registerTool(
    "metabase_duckdb_lock_fix",
    {
      title: "Fix DuckDB Stale Lock",
      description: `Fix the DuckDB file lock conflict that occurs when Metabase restarts.
Symptom: "IO Error: Conflicting lock is held in PID 0" on analytics.duckdb.
Fix: restart duckdb-api first (clears the stale lock), then restart Metabase.
The lock occurs because the previous Metabase pod held the lock; when killed, PID 0 remains in the lock record.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async () => {
      const lines: string[] = [];

      lines.push("=== Step 1: Restart duckdb-api (clears stale lock) ===");
      const r1 = await runOnNode(
        "omv-main",
        `${KUBECTL} rollout restart ${DUCKDB_DEPLOY} -n ${NS} && ` +
          `${KUBECTL} rollout status ${DUCKDB_DEPLOY} -n ${NS} --timeout=60s`,
      );
      lines.push(r1.stdout || r1.error || "done");

      lines.push("\n=== Step 2: Restart Metabase ===");
      const r2 = await runOnNode(
        "omv-main",
        `${KUBECTL} rollout restart ${MB_DEPLOY} -n ${NS}`,
      );
      lines.push(r2.stdout || r2.error || "done");
      lines.push("Metabase will be ready in ~4.5 minutes (initialDelaySeconds=240).");

      lines.push("\n=== Current pod state ===");
      const r3 = await runOnNode("omv-main", `${KUBECTL} get pods -n ${NS} -o wide`);
      lines.push(r3.stdout || r3.error || "");

      return { content: [{ type: "text", text: "```\n" + lines.join("\n") + "\n```" }] };
    },
  );

  // ── metabase_get_logs ─────────────────────────────────────────────────────
  server.registerTool(
    "metabase_get_logs",
    {
      title: "Metabase Pod Logs",
      description: `Get recent logs from the Metabase pod.
Note: metabase.middleware.log DEBUG spam (health-check lines) cannot be suppressed in v0.55 OSS — Metabase programmatically resets logger levels. This is cosmetic only and does not affect function.`,
      inputSchema: z.object({
        lines: z
          .number()
          .default(50)
          .describe("Number of log lines to return (tail)"),
        grep: z
          .string()
          .optional()
          .describe("Filter logs by this string (case-insensitive grep)"),
        since: z
          .string()
          .optional()
          .describe('Show logs since this duration (e.g., "5m", "1h")'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ lines, grep, since }) => {
      const sinceFlag = since ? `--since=${since}` : "";
      const tailFlag = `--tail=${lines}`;
      let cmd = `${KUBECTL} logs ${MB_DEPLOY} -n ${NS} ${sinceFlag} ${tailFlag}`;
      if (grep) {
        cmd += ` | grep -i '${grep.replace(/'/g, "'\\''")}'`;
      }
      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ ${r.error}`
        : "```\n" + (r.stdout || "(no output)") + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );
}
