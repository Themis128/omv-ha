import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runOnNode } from "../services/ssh.js";

const KUBECTL = "sudo k3s kubectl";
const NS = "analytics";
const DUCKDB_URL = "http://duckdb-api.analytics.svc.cluster.local";
const ML_TOKEN = "zIV2hgvUb481sGOBX6ilZkfDtcwQ5njN";
const S3_BUCKET = "cloudless-analytics-data";

const CRONJOBS = [
  "ml-feature-engineer",
  "ml-train-rfm",
  "ml-train-collab",
  "ml-train-churn",
  "ml-train-anomaly",
  "ml-detect-anomaly",
  "ml-content-decay",
] as const;

type CronJobName = (typeof CRONJOBS)[number];

const CronJobSchema = z
  .enum(CRONJOBS)
  .describe("ML pipeline CronJob name");

function duckdbQueryCmd(sql: string): string {
  const escaped = sql.replace(/"/g, '\\"').replace(/\n/g, " ");
  return (
    `${KUBECTL} exec -n ${NS} deployment/duckdb-api -- ` +
    `curl -sf -X POST http://localhost:8000/query ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"sql":"${escaped}","limit":100}'`
  );
}

export function registerMlTools(server: McpServer): void {
  // ── ml_pipeline_status ────────────────────────────────────────────────────
  server.registerTool(
    "ml_pipeline_status",
    {
      title: "ML Pipeline Status",
      description: `Check status of all ML pipeline CronJobs in the analytics namespace.
Shows: last schedule time, last successful run, active jobs, recent pod states.
Also reports recent Job runs (last 3 per CronJob) with completion status and duration.
Use this to diagnose pipeline failures or verify a successful weekly training run.`,
      inputSchema: z.object({
        job: CronJobSchema.optional().describe(
          "Filter to a specific CronJob (omit for all 7 jobs)",
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ job }) => {
      const selector = job ? `-l job-name=${job}` : `-l app=ml-pipeline`;
      const cmd =
        `${KUBECTL} get cronjobs -n ${NS} -l app=ml-pipeline` +
        ` && echo '--- Recent Jobs ---'` +
        ` && ${KUBECTL} get jobs -n ${NS} -l app=ml-pipeline --sort-by=.metadata.creationTimestamp` +
        ` && echo '--- Recent Pods ---'` +
        ` && ${KUBECTL} get pods -n ${NS} ${selector} --sort-by=.metadata.creationTimestamp`;

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```\n" + r.stdout + (r.stderr ? "\nSTDERR:\n" + r.stderr : "") + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_trigger_job ────────────────────────────────────────────────────────
  server.registerTool(
    "ml_trigger_job",
    {
      title: "Manually Trigger ML Pipeline Job",
      description: `Create an immediate Job from an ML CronJob (equivalent to kubectl create job --from=cronjob).
Use this to run a pipeline step on-demand without waiting for the next schedule.
Normal trigger order: ml-feature-engineer → ml-train-rfm → ml-train-churn → ml-train-collab → ml-train-anomaly.
⚠️  concurrencyPolicy: Forbid — if a job is already running for this CronJob, the new one will pend until it completes.`,
      inputSchema: z.object({
        job: CronJobSchema.describe("Which CronJob to trigger"),
        suffix: z
          .string()
          .default("manual")
          .describe("Suffix appended to the job name (e.g. 'manual', 'test')"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ job, suffix }) => {
      const jobName = `${job}-${suffix}-${Date.now().toString(36)}`;
      const cmd =
        `${KUBECTL} create job ${jobName} --from=cronjob/${job} -n ${NS}` +
        ` && echo '--- Job created ---'` +
        ` && ${KUBECTL} get job ${jobName} -n ${NS}` +
        ` && echo '--- Waiting for pod ---'` +
        ` && sleep 3` +
        ` && ${KUBECTL} get pods -n ${NS} -l job-name=${jobName}`;

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```\n" + r.stdout + (r.stderr ? "\nSTDERR:\n" + r.stderr : "") + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_get_logs ───────────────────────────────────────────────────────────
  server.registerTool(
    "ml_get_logs",
    {
      title: "Get ML Job Logs",
      description: `Stream logs from the most recent pod of an ML CronJob.
Use after ml_trigger_job or ml_pipeline_status to diagnose failures or confirm success.
Fetches the last 200 lines by default.`,
      inputSchema: z.object({
        job: CronJobSchema.describe("Which CronJob's logs to fetch"),
        lines: z
          .number()
          .int()
          .min(10)
          .max(1000)
          .default(200)
          .describe("Number of log lines to return"),
        previous: z
          .boolean()
          .default(false)
          .describe("Show logs from the previous (failed/terminated) container"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ job, lines, previous }) => {
      const prevFlag = previous ? "--previous" : "";
      const cmd =
        `POD=$(${KUBECTL} get pods -n ${NS} -l job-name --sort-by=.metadata.creationTimestamp ` +
        `--field-selector=status.phase!=Pending ` +
        `2>/dev/null | grep "${job}" | tail -1 | awk '{print $1}')` +
        ` && if [ -z "$POD" ]; then` +
        `   echo "No pods found for ${job}";` +
        ` else` +
        `   echo "=== Logs for $POD ===" && ${KUBECTL} logs -n ${NS} $POD ${prevFlag} --tail=${lines};` +
        ` fi`;

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```\n" + r.stdout + (r.stderr ? "\nSTDERR:\n" + r.stderr : "") + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_run_history ────────────────────────────────────────────────────────
  server.registerTool(
    "ml_run_history",
    {
      title: "ML Run History",
      description: `Query the ml_runs table in DuckDB for training run history.
Returns: model name, training timestamp, metrics (AUC/inertia/etc), training row count, champion flag.
Requires at least one successful ml-feature-engineer + training run to have data.`,
      inputSchema: z.object({
        model: z
          .enum(["rfm", "churn", "collab", "anomaly", "all"])
          .default("all")
          .describe("Which model's runs to query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of rows to return (most recent first)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ model, limit }) => {
      const where = model !== "all" ? `WHERE model_name='${model}'` : "";
      const sql =
        `SELECT model_name, trained_at, training_rows, is_champion, ` +
        `metrics FROM ml_runs ${where} ` +
        `ORDER BY trained_at DESC LIMIT ${limit}`;

      const cmd = duckdbQueryCmd(sql);
      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```json\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_get_scores ─────────────────────────────────────────────────────────
  server.registerTool(
    "ml_get_scores",
    {
      title: "Get ML Scores",
      description: `Query ML score tables from DuckDB.
Available tables: scores_rfm (user segments), scores_churn (churn probability),
scores_recs (recommendations), anomaly_flags (API anomalies), scores_decay (content decay).
Returns the first N rows with all columns.`,
      inputSchema: z.object({
        table: z
          .enum(["scores_rfm", "scores_churn", "scores_recs", "anomaly_flags", "scores_decay"])
          .describe("Which scores table to query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Rows to return"),
        where: z
          .string()
          .optional()
          .describe("Optional SQL WHERE clause (e.g. \"segment='champions'\" or \"churn_label='high'\")"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ table, limit, where }) => {
      const whereClause = where ? ` WHERE ${where}` : "";
      const sql = `SELECT * FROM ${table}${whereClause} LIMIT ${limit}`;
      const cmd = duckdbQueryCmd(sql);
      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```json\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_check_models ───────────────────────────────────────────────────────
  server.registerTool(
    "ml_check_models",
    {
      title: "Check ML Models in S3",
      description: `List ML model files stored in S3 under the ml-models/ prefix.
Shows: model name, version (latest + dated backups), file size, last modified.
Use this to confirm a training job successfully saved its model artifact.`,
      inputSchema: z.object({
        model: z
          .enum(["rfm", "churn", "collab", "anomaly", "all"])
          .default("all")
          .describe("Which model to check (default: all)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ model }) => {
      const prefix = model !== "all" ? `ml-models/${model}/` : "ml-models/";
      const cmd =
        `AWS_DEFAULT_REGION=us-east-1 aws s3 ls s3://${S3_BUCKET}/${prefix} --recursive` +
        ` && echo '--- Parquet scores ---'` +
        ` && AWS_DEFAULT_REGION=us-east-1 aws s3 ls s3://${S3_BUCKET}/ml-parquet/ 2>/dev/null || echo "(none yet)"`;

      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```\n" + r.stdout + (r.stderr ? "\nSTDERR:\n" + r.stderr : "") + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_anomaly_latest ─────────────────────────────────────────────────────
  server.registerTool(
    "ml_anomaly_latest",
    {
      title: "Latest Anomaly Detections",
      description: `Query the most recent anomaly_flags from DuckDB.
The anomaly-detect CronJob runs every 15 minutes scoring API request windows.
Returns: window_start, is_anomaly, anomaly_score, request_count, error_rate, p95_ms.
High anomaly_score (closer to 0 or positive) = more anomalous; threshold is typically around -0.15.`,
      inputSchema: z.object({
        anomalies_only: z
          .boolean()
          .default(true)
          .describe("Return only flagged anomalies (is_anomaly=true) — set false for all windows"),
        hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .default(24)
          .describe("Look back N hours"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ anomalies_only, hours }) => {
      const whereAnomaly = anomalies_only ? "AND is_anomaly=true" : "";
      const sql =
        `SELECT window_start, is_anomaly, anomaly_score, request_count, error_rate, p95_ms, scored_at ` +
        `FROM anomaly_flags ` +
        `WHERE scored_at >= NOW() - INTERVAL '${hours} hours' ${whereAnomaly} ` +
        `ORDER BY scored_at DESC LIMIT 50`;

      const cmd = duckdbQueryCmd(sql);
      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```json\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_feature_summary ────────────────────────────────────────────────────
  server.registerTool(
    "ml_feature_summary",
    {
      title: "ML Feature Engineering Summary",
      description: `Query ml_features table to see what feature sets have been computed and when.
Shows: feature_name, computed_at, row_count, s3_parquet_path.
Use to verify the ml-feature-engineer job ran successfully before triggering training jobs.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const sql =
        `SELECT feature_name, computed_at, row_count, s3_parquet_path ` +
        `FROM ml_features ORDER BY computed_at DESC LIMIT 20`;

      const cmd = duckdbQueryCmd(sql);
      const r = await runOnNode("omv-main", cmd);
      const text = r.error
        ? `❌ SSH failed: ${r.error}`
        : "```json\n" + r.stdout + "\n```";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── ml_duckdb_unlock ──────────────────────────────────────────────────────
  server.registerTool(
    "ml_duckdb_unlock",
    {
      title: "Fix DuckDB Stale Lock",
      description: `Clear a stale PID-0 DuckDB file lock that causes HTTP 503 from duckdb-api.
This happens when a process dies without releasing the lock embedded in the .duckdb file header.

Recovery procedure (automated):
1. Scale duckdb-api and metabase to 0 replicas (releases open file handles)
2. Run a one-shot duckdb-api-local container via the duckdb-unlock Job manifest
3. The Job connects to the DB, runs CHECKPOINT, and exits — releasing the lock
4. Scale duckdb-api and metabase back to 1 replica

⚠️  This takes ~30 seconds and briefly interrupts analytics access.
Run ml_pipeline_status first to confirm the 503 is lock-related (not a code error).`,
      inputSchema: z.object({
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, only show what would be done without making changes"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ dry_run }) => {
      if (dry_run) {
        return {
          content: [{
            type: "text",
            text: [
              "**DRY RUN — unlock procedure:**",
              "1. `kubectl scale deployment duckdb-api -n analytics --replicas=0`",
              "2. `kubectl scale deployment metabase -n analytics --replicas=0`",
              "3. `kubectl apply -f k8s/ml/duckdb-unlock-job.yaml` (Job: CHECKPOINT + exit)",
              "4. Wait for Job completion (~15s)",
              "5. `kubectl scale deployment duckdb-api -n analytics --replicas=1`",
              "6. `kubectl scale deployment metabase -n analytics --replicas=1`",
              "",
              "Run with dry_run=false to execute.",
            ].join("\n"),
          }],
        };
      }

      const steps: string[] = [];
      const run = async (label: string, cmd: string) => {
        steps.push(`\n▶ ${label}`);
        const r = await runOnNode("omv-main", cmd);
        if (r.error) throw new Error(`${label} failed: ${r.error}`);
        if (r.stdout) steps.push(r.stdout.trim());
        if (r.stderr) steps.push(`STDERR: ${r.stderr.trim()}`);
      };

      try {
        await run(
          "Scale duckdb-api to 0",
          `${KUBECTL} scale deployment duckdb-api -n ${NS} --replicas=0`,
        );
        await run(
          "Scale metabase to 0",
          `${KUBECTL} scale deployment metabase -n ${NS} --replicas=0`,
        );
        await run(
          "Wait for pods to terminate",
          `${KUBECTL} wait --for=delete pod -l app=duckdb-api -n ${NS} --timeout=30s 2>/dev/null || true`,
        );
        await run(
          "Delete any previous unlock job",
          `${KUBECTL} delete job duckdb-unlock -n ${NS} --ignore-not-found`,
        );
        await run(
          "Apply duckdb-unlock Job",
          `${KUBECTL} apply -f /root/omv-ha/k8s/ml/duckdb-unlock-job.yaml`,
        );
        await run(
          "Wait for Job to complete",
          `${KUBECTL} wait --for=condition=complete job/duckdb-unlock -n ${NS} --timeout=60s`,
        );
        await run(
          "Job logs",
          `${KUBECTL} logs -n ${NS} -l job-name=duckdb-unlock`,
        );
        await run(
          "Scale duckdb-api back to 1",
          `${KUBECTL} scale deployment duckdb-api -n ${NS} --replicas=1`,
        );
        await run(
          "Scale metabase back to 1",
          `${KUBECTL} scale deployment metabase -n ${NS} --replicas=1`,
        );
        await run(
          "Verify duckdb-api health",
          `sleep 8 && ${KUBECTL} exec -n ${NS} deployment/duckdb-api -- curl -sf http://localhost:8000/health`,
        );

        steps.push("\n✅ DuckDB lock cleared — analytics stack is back online.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push(`\n❌ Unlock failed at step: ${msg}`);
        steps.push("You may need to scale deployments back up manually.");
      }

      return { content: [{ type: "text", text: "```\n" + steps.join("\n") + "\n```" }] };
    },
  );
}
