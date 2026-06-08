import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { runOnNode } from "../services/ssh.js";
const execFileAsync = promisify(execFile);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const GH_REPOS = {
    "cloudless.gr": "Themis128/cloudless.gr",
    "cloudless-manager": "Themis128/cloudless-manager",
    "omv-ha": "Themis128/omv-ha",
};
/** Run a gh CLI command on Windows and return parsed JSON or raw text. */
async function ghJson(args) {
    const { stdout } = await execFileAsync("gh", args, {
        encoding: "utf8",
        timeout: 30_000,
    });
    return JSON.parse(stdout);
}
async function ghRaw(args) {
    const { stdout } = await execFileAsync("gh", args, {
        encoding: "utf8",
        timeout: 30_000,
    });
    return stdout.trim();
}
function resolveRepo(alias) {
    return GH_REPOS[alias] ?? alias;
}
// ---------------------------------------------------------------------------
// Tool: gh_runner_list
// ---------------------------------------------------------------------------
export function registerGithubTools(server) {
    server.registerTool("gh_runner_list", {
        title: "GitHub Runners — List",
        description: `List self-hosted runners registered to a GitHub repo.
Returns runner name, status (online/offline), OS, labels, and busy state.
Use to verify a runner is online before triggering a workflow.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias. Resolves to Themis128/<repo>."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo }) => {
        const fullRepo = resolveRepo(repo);
        try {
            const data = await ghJson(["api", `repos/${fullRepo}/actions/runners`]);
            if (data.total_count === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `⚠️ No self-hosted runners registered to **${fullRepo}**.\nUse \`gh_runner_register\` to add one.`,
                        },
                    ],
                };
            }
            const lines = data.runners.map((r) => {
                const icon = r.status === "online" ? "🟢" : "🔴";
                const busy = r.busy ? " [BUSY]" : "";
                const labels = r.labels.map((l) => l.name).join(", ");
                return `${icon} **${r.name}** — ${r.status}${busy} | ${r.os} | labels: ${labels}`;
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `## Runners for ${fullRepo} (${data.total_count})\n\n${lines.join("\n")}`,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_register ──────────────────────────────────────────────────
    server.registerTool("gh_runner_register", {
        title: "GitHub Runner — Register omv-main",
        description: `Register the omv-main self-hosted runner to a GitHub repo.
Generates a registration token via GitHub API, SSHs to omv-main, extracts the runner
tarball into ~/actions-runner-<repo-short-name>/, runs config.sh, installs and starts
a systemd service. Idempotent — skips if already registered.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias to register the runner for."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo }) => {
        const fullRepo = resolveRepo(repo);
        const shortName = repo.replace(".", "-");
        const runnerDir = `~/actions-runner-${shortName}`;
        // Check if already registered
        try {
            const data = await ghJson([
                "api",
                `repos/${fullRepo}/actions/runners`,
            ]);
            if (data.total_count > 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `ℹ️ Runner already registered to **${fullRepo}**. Use \`gh_runner_list\` to check status.`,
                        },
                    ],
                };
            }
        }
        catch (_) {
            /* proceed */
        }
        // Generate registration token
        let token;
        try {
            const resp = await ghJson([
                "api",
                "-X",
                "POST",
                `repos/${fullRepo}/actions/runners/registration-token`,
            ]);
            token = resp.token;
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Failed to get registration token: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
        // SSH: create dir, extract tarball, configure, install service
        const serviceUnit = `actions.runner.${fullRepo.replace("/", "-")}.omv.service`;
        const cmd = [
            // Create dir and extract runner tarball from the base installation
            `mkdir -p ${runnerDir}`,
            `cd ${runnerDir} && tar xzf ~/actions-runner/runner.tar.gz`,
            // Configure (unattended)
            `cd ${runnerDir} && ./config.sh --url https://github.com/${fullRepo} --token ${token} --name omv --labels self-hosted,omv,Linux,ARM64 --unattended 2>&1`,
            // Install + start systemd service
            `cd ${runnerDir} && sudo ./svc.sh install tbaltzakis 2>&1`,
            `cd ${runnerDir} && sudo ./svc.sh start 2>&1`,
            // Brief status
            `systemctl is-active ${serviceUnit} 2>/dev/null || echo unknown`,
        ].join(" && ");
        const r = await runOnNode("omv-main", cmd);
        const ok = r.code === 0;
        const status = ok
            ? "✅ Runner registered and running"
            : "❌ Registration failed";
        return {
            content: [
                {
                    type: "text",
                    text: `## ${status}\n\n**Repo:** ${fullRepo}\n**Dir:** ${runnerDir}\n**Service:** ${serviceUnit}\n\n\`\`\`\n${r.stdout || r.stderr}\n\`\`\``,
                },
            ],
        };
    });
    // ── gh_workflow_trigger ─────────────────────────────────────────────────
    server.registerTool("gh_workflow_trigger", {
        title: "GitHub Workflow — Trigger dispatch",
        description: `Trigger a workflow_dispatch on a GitHub repo and return the new run ID.
Use to manually kick off a CI/CD pipeline (e.g., deploy-pi.yml, deploy.yml).`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            workflow: z
                .string()
                .describe('Workflow filename (e.g., "deploy-pi.yml", "deploy.yml").'),
            ref: z
                .string()
                .default("main")
                .describe("Git ref (branch/tag) to run on. Defaults to main."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo, workflow, ref }) => {
        const fullRepo = resolveRepo(repo);
        try {
            await ghRaw([
                "workflow",
                "run",
                workflow,
                "--repo",
                fullRepo,
                "--ref",
                ref,
            ]);
            // Wait briefly then fetch the new run ID
            await new Promise((r) => setTimeout(r, 3000));
            const raw = await ghRaw([
                "run",
                "list",
                "--repo",
                fullRepo,
                "--workflow",
                workflow,
                "--limit",
                "1",
                "--json",
                "databaseId,status,displayTitle,createdAt",
            ]);
            const runs = JSON.parse(raw);
            const run = runs[0];
            if (!run)
                return {
                    content: [
                        {
                            type: "text",
                            text: `✅ Workflow \`${workflow}\` triggered on **${fullRepo}**. Run ID not yet available — use \`gh_workflow_watch\` in a moment.`,
                        },
                    ],
                };
            return {
                content: [
                    {
                        type: "text",
                        text: `✅ Triggered \`${workflow}\` on **${fullRepo}**\n\n**Run ID:** ${run.databaseId}\n**Status:** ${run.status}\n**Title:** ${run.displayTitle}\n**Started:** ${run.createdAt}\n\nUse \`gh_workflow_watch\` with run_id \`${run.databaseId}\` to follow progress.`,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error triggering workflow: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_workflow_watch ───────────────────────────────────────────────────
    server.registerTool("gh_workflow_watch", {
        title: "GitHub Workflow — Watch run",
        description: `Poll a GitHub Actions workflow run until it completes (or times out).
Returns job-by-job step status and final conclusion.
Poll interval: 20s. Timeout: configurable, default 15 min.
Use after gh_workflow_trigger to follow a CI/CD pipeline to completion.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            run_id: z
                .number()
                .describe("Workflow run ID (from gh_workflow_trigger or gh run list)."),
            timeout_minutes: z
                .number()
                .default(15)
                .describe("Max minutes to wait before returning. Default 15."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, run_id, timeout_minutes }) => {
        const fullRepo = resolveRepo(repo);
        const deadline = Date.now() + timeout_minutes * 60 * 1000;
        const pollMs = 20_000;
        const formatJobs = (jobs) => jobs
            .map((j) => {
            const jIcon = j.conclusion === "success"
                ? "✅"
                : j.conclusion === "failure"
                    ? "❌"
                    : j.status === "in_progress"
                        ? "⏳"
                        : "⏸";
            const steps = j.steps
                .map((s) => {
                const sIcon = s.conclusion === "success"
                    ? "✓"
                    : s.conclusion === "failure"
                        ? "✗"
                        : s.status === "in_progress"
                            ? "▶"
                            : "·";
                return `    ${sIcon} ${s.name}`;
            })
                .join("\n");
            return `${jIcon} **${j.name}** (${j.status}${j.conclusion ? " / " + j.conclusion : ""})\n${steps}`;
        })
            .join("\n\n");
        while (Date.now() < deadline) {
            try {
                const data = await ghJson([
                    "run",
                    "view",
                    String(run_id),
                    "--repo",
                    fullRepo,
                    "--json",
                    "status,conclusion,jobs",
                ]);
                if (data.status === "completed") {
                    const icon = data.conclusion === "success" ? "✅" : "❌";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `## ${icon} Run ${run_id} — ${data.conclusion.toUpperCase()}\n\n${formatJobs(data.jobs)}\n\nView: https://github.com/${fullRepo}/actions/runs/${run_id}`,
                            },
                        ],
                    };
                }
                // Still running — wait and poll again
                await new Promise((r) => setTimeout(r, pollMs));
            }
            catch (err) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `❌ Error polling run: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                };
            }
        }
        return {
            content: [
                {
                    type: "text",
                    text: `⏱️ Timeout after ${timeout_minutes} min — run ${run_id} is still in progress.\nView: https://github.com/${fullRepo}/actions/runs/${run_id}`,
                },
            ],
        };
    });
    // ── gh_workflow_list ────────────────────────────────────────────────────
    server.registerTool("gh_workflow_list", {
        title: "GitHub Workflow — List recent runs",
        description: `List the most recent workflow runs for a repo, with status and conclusion.
Useful for a quick CI health check without needing a specific run ID.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            limit: z
                .number()
                .default(8)
                .describe("Number of runs to return. Default 8."),
            workflow: z
                .string()
                .optional()
                .describe('Filter by workflow filename (e.g., "deploy-pi.yml"). Omit for all.'),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, limit, workflow }) => {
        const fullRepo = resolveRepo(repo);
        const args = [
            "run",
            "list",
            "--repo",
            fullRepo,
            "--limit",
            String(limit),
            "--json",
            "databaseId,displayTitle,workflowName,status,conclusion,createdAt,headBranch",
        ];
        if (workflow)
            args.push("--workflow", workflow);
        try {
            const runs = await ghJson(args);
            if (runs.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No workflow runs found for **${fullRepo}**.`,
                        },
                    ],
                };
            }
            const lines = runs.map((r) => {
                const icon = r.conclusion === "success"
                    ? "✅"
                    : r.conclusion === "failure"
                        ? "❌"
                        : r.status === "in_progress"
                            ? "⏳"
                            : r.status === "queued"
                                ? "⏸"
                                : "·";
                const ts = new Date(r.createdAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ");
                return `${icon} \`${r.databaseId}\` **${r.workflowName}** — ${r.conclusion || r.status} | ${r.headBranch} | ${ts} | ${r.displayTitle}`;
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `## Recent runs — ${fullRepo}\n\n${lines.join("\n")}`,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_health ────────────────────────────────────────────────────
    server.registerTool("gh_runner_health", {
        title: "GitHub Runners — Fleet health",
        description: `Full health check of a repo's self-hosted runner fleet.
Lists each runner (online/offline/busy/labels), counts queued vs in-progress
workflow runs, and flags two specific failure modes:
  • Zombie runner — reported "busy" while zero jobs are actually in_progress
    AND work is queued (fix: re-register the runner, see /runner-ops skill).
  • Billing lock — the most recent failed run has a job that failed in seconds
    with no steps: the signature of "account is locked due to a billing issue".
    GitHub-hosted runners are then disabled account-wide; self-hosted keep working.
Returns a HEALTHY / DEGRADED / CRITICAL verdict.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias. Resolves to Themis128/<repo>."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo }) => {
        const fullRepo = resolveRepo(repo);
        try {
            // 1. Runner fleet
            const runnersData = await ghJson(["api", `repos/${fullRepo}/actions/runners`]);
            // 2. Queue depth — recent runs
            const runs = await ghJson([
                "run",
                "list",
                "--repo",
                fullRepo,
                "--limit",
                "60",
                "--json",
                "databaseId,status,conclusion,workflowName",
            ]);
            const queued = runs.filter((r) => r.status === "queued").length;
            const inProgress = runs.filter((r) => r.status === "in_progress").length;
            const online = runnersData.runners.filter((r) => r.status === "online");
            const offline = runnersData.runners.filter((r) => r.status !== "online");
            const busy = online.filter((r) => r.busy);
            // 3. Zombie detection — runners report busy but nothing is in_progress
            const zombie = busy.length > 0 && inProgress === 0 && queued > 0;
            // 4. Billing-lock probe — most recent failed run with a 0-step job that
            //    failed in <15s is the signature of an account billing lock.
            let billingLock = false;
            const lastFail = runs.find((r) => r.status === "completed" && r.conclusion === "failure");
            if (lastFail) {
                try {
                    const jobsResp = await ghJson([
                        "api",
                        `repos/${fullRepo}/actions/runs/${lastFail.databaseId}/jobs`,
                    ]);
                    billingLock = jobsResp.jobs.some((j) => {
                        if (j.conclusion !== "failure" || (j.steps?.length ?? 0) > 0)
                            return false;
                        const dt = new Date(j.completed_at).getTime() -
                            new Date(j.started_at).getTime();
                        return dt >= 0 && dt < 15_000;
                    });
                }
                catch (_) {
                    /* probe is best-effort */
                }
            }
            // Verdict
            let verdict = "HEALTHY";
            const issues = [];
            if (billingLock) {
                verdict = "CRITICAL";
                issues.push("Billing lock — GitHub-hosted runners disabled account-wide. " +
                    "Resolve at github.com/settings/billing. Self-hosted runners still work.");
            }
            if (online.length === 0 && runnersData.total_count > 0) {
                verdict = "CRITICAL";
                issues.push("All self-hosted runners are offline.");
            }
            if (zombie) {
                if (verdict !== "CRITICAL")
                    verdict = "DEGRADED";
                issues.push(`Zombie runner(s): ${busy.length} report busy but 0 jobs in_progress ` +
                    `with ${queued} queued. Re-register the affected runner(s).`);
            }
            if (offline.length > 0 && online.length > 0) {
                if (verdict === "HEALTHY")
                    verdict = "DEGRADED";
                issues.push(`${offline.length} runner(s) offline: ${offline.map((r) => r.name).join(", ")}.`);
            }
            if (online.length > 0 && queued > online.length * 4) {
                if (verdict === "HEALTHY")
                    verdict = "DEGRADED";
                issues.push(`Deep backlog: ${queued} queued across ${online.length} online runner(s).`);
            }
            const runnerLines = runnersData.runners.length === 0
                ? ["(no self-hosted runners registered)"]
                : runnersData.runners.map((r) => {
                    const icon = r.status === "online" ? "🟢" : "🔴";
                    const b = r.busy ? " [BUSY]" : " [idle]";
                    return `${icon} **${r.name}**${b} — ${r.labels.map((l) => l.name).join(", ")}`;
                });
            const icon = verdict === "HEALTHY" ? "✅" : verdict === "DEGRADED" ? "⚠️" : "🛑";
            const issueText = issues.length > 0
                ? `\n\n**Issues:**\n${issues.map((i) => `  - ${i}`).join("\n")}`
                : "";
            return {
                content: [
                    {
                        type: "text",
                        text: `## ${icon} RUNNER FLEET: ${verdict} — ${fullRepo}\n\n` +
                            `**Runners (${runnersData.total_count}):**\n${runnerLines.join("\n")}\n\n` +
                            `**Queue:** ${queued} queued · ${inProgress} in-progress · ${online.length} online runner(s)` +
                            issueText,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_set_labels ────────────────────────────────────────────────
    server.registerTool("gh_runner_set_labels", {
        title: "GitHub Runner — Set labels",
        description: `Add custom labels to a self-hosted runner, or replace its full
custom label set, via the GitHub API — no re-registration or restart needed.

runs-on matches by AND: a job runs on a runner only if that runner carries EVERY
label in the job's runs-on array. Use this to partition a fleet into pools — e.g.
add a 'pi' label to cluster-capable runners so cluster-only workflows pinned to
[self-hosted, omv, pi] never land on a generic [self-hosted, omv] runner.

Default labels (self-hosted, the OS, the arch) are managed by GitHub and cannot
be set here.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            runner: z
                .string()
                .describe("Runner name (e.g. 'omv-2') or its numeric id."),
            labels: z.array(z.string()).describe("Custom labels to apply."),
            mode: z
                .enum(["add", "replace"])
                .default("add")
                .describe("'add' appends to existing custom labels; 'replace' overwrites the whole custom set."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo, runner, labels, mode }) => {
        const fullRepo = resolveRepo(repo);
        try {
            const data = await ghJson(["api", `repos/${fullRepo}/actions/runners`]);
            const match = data.runners.find((r) => r.name === runner || String(r.id) === runner);
            if (!match) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `❌ No runner named or id '${runner}' on **${fullRepo}**. ` +
                                `Known: ${data.runners.map((r) => r.name).join(", ") || "(none)"}.`,
                        },
                    ],
                };
            }
            const method = mode === "replace" ? "PUT" : "POST";
            const args = [
                "api",
                "-X",
                method,
                `repos/${fullRepo}/actions/runners/${match.id}/labels`,
            ];
            for (const l of labels)
                args.push("-f", `labels[]=${l}`);
            const resp = await ghJson(args);
            return {
                content: [
                    {
                        type: "text",
                        text: `✅ Runner **${match.name}** (${mode}) — labels now: ` +
                            resp.labels.map((l) => l.name).join(", "),
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_restart ────────────────────────────────────────────────────
    server.registerTool("gh_runner_restart", {
        title: "GitHub Runner — Restart service",
        description: `Restart the GitHub Actions self-hosted runner systemd service on omv-main via SSH.
Use after applying a systemd override or when the runner appears stuck or offline.
Service name is derived as: actions.runner.Themis128-{repo}.{runner}.service`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            runner: z
                .string()
                .default("omv")
                .describe("Runner name (default: omv)."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo, runner }) => {
        const svc = `actions.runner.Themis128-${repo}.${runner}.service`;
        try {
            const out = await runOnNode("omv-main", `sudo systemctl restart ${svc} && echo "ok" && systemctl is-active ${svc}`);
            return {
                content: [
                    {
                        type: "text",
                        text: `✅ **${svc}** restarted.\n\`\`\`\n${out}\n\`\`\``,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_fix_service ────────────────────────────────────────────────
    server.registerTool("gh_runner_fix_service", {
        title: "GitHub Runner — Apply systemd hardening override",
        description: `Write an idempotent systemd drop-in override for the runner service on omv-main.
Sets: Restart=on-failure, RestartSec=10s, StartLimitIntervalSec=0, network-online.target
dependency, RUNNER_RETRY_RENEW_SECONDS=300, DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=1.
Also writes /etc/systemd/resolved.conf.d/retry.conf with Google + Cloudflare + Quad9 DNS.
Runs daemon-reload and restarts the service. Idempotent — safe to run repeatedly.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            runner: z
                .string()
                .default("omv")
                .describe("Runner name (default: omv)."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo, runner }) => {
        const svc = `actions.runner.Themis128-${repo}.${runner}.service`;
        const d = `/etc/systemd/system/${svc}.d`;
        const writeOverride = [
            `sudo mkdir -p ${d}`,
            `{ echo "[Unit]"; echo "Wants=network-online.target"; echo "After=network-online.target"; echo ""; echo "[Service]"; echo "Restart=on-failure"; echo "RestartSec=10s"; echo "StartLimitIntervalSec=0"; echo 'Environment="DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=1"'; echo 'Environment="RUNNER_RETRY_RENEW_SECONDS=300"'; } | sudo tee ${d}/override.conf`,
            `sudo mkdir -p /etc/systemd/resolved.conf.d`,
            `{ echo "[Resolve]"; echo "DNS=8.8.8.8 8.8.4.4 1.1.1.1"; echo "FallbackDNS=9.9.9.9"; echo "DNSStubListener=yes"; echo "Cache=yes"; } | sudo tee /etc/systemd/resolved.conf.d/retry.conf`,
            `sudo systemctl daemon-reload`,
            `sudo systemctl restart ${svc}`,
            `systemctl is-active ${svc}`,
        ].join(" && ");
        try {
            const out = await runOnNode("omv-main", writeOverride);
            return {
                content: [
                    {
                        type: "text",
                        text: `✅ Systemd override applied and service restarted.\n\`\`\`\n${out}\n\`\`\``,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_logs ───────────────────────────────────────────────────────
    server.registerTool("gh_runner_logs", {
        title: "GitHub Runner — Fetch service logs",
        description: `Fetch recent journalctl logs from the GitHub Actions runner service on omv-main.
Useful for diagnosing connection drops, DNS failures, job hangs, or stuck runs.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            runner: z
                .string()
                .default("omv")
                .describe("Runner name (default: omv)."),
            lines: z
                .number()
                .int()
                .min(10)
                .max(500)
                .default(50)
                .describe("Number of log lines to return."),
            since: z
                .string()
                .optional()
                .describe("journalctl --since value, e.g. '10 minutes ago' or '2025-05-23 01:00'."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, runner, lines, since }) => {
        const svc = `actions.runner.Themis128-${repo}.${runner}.service`;
        const sf = since ? `--since "${since}"` : "";
        try {
            const out = await runOnNode("omv-main", `journalctl -u ${svc} ${sf} -n ${lines} --no-pager --output=short-iso 2>&1`);
            return {
                content: [
                    {
                        type: "text",
                        text: `## Runner logs: ${svc}\n\`\`\`\n${out}\n\`\`\``,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_cancel_stuck ───────────────────────────────────────────────
    server.registerTool("gh_runner_cancel_stuck", {
        title: "GitHub Runner — Cancel stuck workflow runs",
        description: `Cancel all queued or in-progress workflow runs for a repo.
Use when the self-hosted runner crashed mid-job and GitHub still shows runs as queued/in-progress.
Fetches both queued and in-progress runs, optionally filters by workflow name, and cancels each.
Set dry_run=true to preview without cancelling.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            workflow: z
                .string()
                .optional()
                .describe("Filter by workflow name (partial match). Omit to cancel ALL stuck runs."),
            dry_run: z
                .boolean()
                .default(false)
                .describe("If true, list what would be cancelled without cancelling."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ repo, workflow, dry_run }) => {
        const fullRepo = resolveRepo(repo);
        try {
            const [q, ip] = await Promise.all([
                ghJson([
                    "api",
                    `repos/${fullRepo}/actions/runs?status=queued&per_page=50`,
                ]),
                ghJson([
                    "api",
                    `repos/${fullRepo}/actions/runs?status=in_progress&per_page=50`,
                ]),
            ]);
            let candidates = [...q.workflow_runs, ...ip.workflow_runs];
            if (workflow) {
                candidates = candidates.filter((r) => r.name.toLowerCase().includes(workflow.toLowerCase()));
            }
            if (candidates.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `✅ No stuck runs on **${fullRepo}**${workflow ? ` matching "${workflow}"` : ""}.`,
                        },
                    ],
                };
            }
            const rows = candidates.map((r) => `  - [${r.name} #${r.id}](${r.html_url}) (${r.status})`);
            if (dry_run) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `**Dry run** — would cancel ${candidates.length} run(s) on ${fullRepo}:\n${rows.join("\n")}`,
                        },
                    ],
                };
            }
            const results = [];
            for (const run of candidates) {
                try {
                    await ghRaw([
                        "api",
                        "-X",
                        "POST",
                        `repos/${fullRepo}/actions/runs/${run.id}/cancel`,
                    ]);
                    results.push(`  ✅ Cancelled [${run.name} #${run.id}](${run.html_url})`);
                }
                catch {
                    results.push(`  ⚠️  Failed to cancel ${run.name} #${run.id}`);
                }
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `## Cancelled ${results.length} run(s) on ${fullRepo}\n\n${results.join("\n")}`,
                    },
                ],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    // ── gh_runner_restart ────────────────────────────────────────────────────
    server.registerTool("gh_runner_restart", {
        title: "GitHub Runner — Restart service",
        description: `Restart the GitHub Actions self-hosted runner systemd service on omv-main via SSH.
Use after applying a systemd override or when the runner appears stuck or offline.
Service name is derived as: actions.runner.Themis128-{repo}.{runner}.service`,
        inputSchema: z.object({
            repo: z.enum(["cloudless.gr", "cloudless-manager", "omv-ha"]).describe("Repo alias."),
            runner: z.string().default("omv").describe("Runner name (default: omv)."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo, runner }) => {
        const svc = `actions.runner.Themis128-${repo}.${runner}.service`;
        try {
            const out = await runOnNode("omv-main", `sudo systemctl restart ${svc} && echo "ok" && systemctl is-active ${svc}`);
            return { content: [{ type: "text", text: `✅ **${svc}** restarted.\n\`\`\`\n${out}\n\`\`\`` }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
    });
    // ── gh_runner_fix_service ────────────────────────────────────────────────
    server.registerTool("gh_runner_fix_service", {
        title: "GitHub Runner — Apply systemd hardening override",
        description: `Write an idempotent systemd drop-in override for the runner service on omv-main.
Sets: Restart=on-failure, RestartSec=10s, StartLimitIntervalSec=0, network-online.target
dependency, RUNNER_RETRY_RENEW_SECONDS=300, DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=1.
Also writes /etc/systemd/resolved.conf.d/retry.conf with Google + Cloudflare + Quad9 DNS.
Runs daemon-reload and restarts the service. Idempotent — safe to run repeatedly.`,
        inputSchema: z.object({
            repo: z.enum(["cloudless.gr", "cloudless-manager", "omv-ha"]).describe("Repo alias."),
            runner: z.string().default("omv").describe("Runner name (default: omv)."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ repo, runner }) => {
        const svc = `actions.runner.Themis128-${repo}.${runner}.service`;
        const d = `/etc/systemd/system/${svc}.d`;
        const writeOverride = [
            `sudo mkdir -p ${d}`,
            `{ echo "[Unit]"; echo "Wants=network-online.target"; echo "After=network-online.target"; echo ""; echo "[Service]"; echo "Restart=on-failure"; echo "RestartSec=10s"; echo "StartLimitIntervalSec=0"; echo 'Environment="DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER=1"'; echo 'Environment="RUNNER_RETRY_RENEW_SECONDS=300"'; } | sudo tee ${d}/override.conf`,
            `sudo mkdir -p /etc/systemd/resolved.conf.d`,
            `{ echo "[Resolve]"; echo "DNS=8.8.8.8 8.8.4.4 1.1.1.1"; echo "FallbackDNS=9.9.9.9"; echo "DNSStubListener=yes"; echo "Cache=yes"; } | sudo tee /etc/systemd/resolved.conf.d/retry.conf`,
            `sudo systemctl daemon-reload`,
            `sudo systemctl restart ${svc}`,
            `systemctl is-active ${svc}`,
        ].join(" && ");
        try {
            const out = await runOnNode("omv-main", writeOverride);
            return { content: [{ type: "text", text: `✅ Systemd override applied and service restarted.\n\`\`\`\n${out}\n\`\`\`` }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
    });
    // ── gh_runner_logs ───────────────────────────────────────────────────────
    server.registerTool("gh_runner_logs", {
        title: "GitHub Runner — Fetch service logs",
        description: `Fetch recent journalctl logs from the GitHub Actions runner service on omv-main.
Useful for diagnosing connection drops, DNS failures, job hangs, or stuck runs.`,
        inputSchema: z.object({
            repo: z.enum(["cloudless.gr", "cloudless-manager", "omv-ha"]).describe("Repo alias."),
            runner: z.string().default("omv").describe("Runner name (default: omv)."),
            lines: z.number().int().min(10).max(500).default(50).describe("Number of log lines to return."),
            since: z.string().optional().describe("journalctl --since value, e.g. '10 minutes ago' or '2025-05-23 01:00'."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, runner, lines, since }) => {
        const svc = `actions.runner.Themis128-${repo}.${runner}.service`;
        const sf = since ? `--since "${since}"` : "";
        try {
            const out = await runOnNode("omv-main", `journalctl -u ${svc} ${sf} -n ${lines} --no-pager --output=short-iso 2>&1`);
            return { content: [{ type: "text", text: `## Runner logs: ${svc}\n\`\`\`\n${out}\n\`\`\`` }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
    });
    // ── gh_runner_cancel_stuck ───────────────────────────────────────────────
    server.registerTool("gh_runner_cancel_stuck", {
        title: "GitHub Runner — Cancel stuck workflow runs",
        description: `Cancel all queued or in-progress workflow runs for a repo.
Use when the self-hosted runner crashed mid-job and GitHub still shows runs as queued/in-progress.
Fetches both queued and in-progress runs, optionally filters by workflow name, and cancels each.
Set dry_run=true to preview without cancelling.`,
        inputSchema: z.object({
            repo: z.enum(["cloudless.gr", "cloudless-manager", "omv-ha"]).describe("Repo alias."),
            workflow: z.string().optional().describe("Filter by workflow name (partial match). Omit to cancel ALL stuck runs."),
            dry_run: z.boolean().default(false).describe("If true, list what would be cancelled without cancelling."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ repo, workflow, dry_run }) => {
        const fullRepo = resolveRepo(repo);
        try {
            const [q, ip] = await Promise.all([
                ghJson(["api", `repos/${fullRepo}/actions/runs?status=queued&per_page=50`]),
                ghJson(["api", `repos/${fullRepo}/actions/runs?status=in_progress&per_page=50`]),
            ]);
            let candidates = [...q.workflow_runs, ...ip.workflow_runs];
            if (workflow) {
                candidates = candidates.filter((r) => r.name.toLowerCase().includes(workflow.toLowerCase()));
            }
            if (candidates.length === 0) {
                return { content: [{ type: "text",
                            text: `✅ No stuck runs on **${fullRepo}**${workflow ? ` matching "${workflow}"` : ""}.` }] };
            }
            const rows = candidates.map((r) => `  - [${r.name} #${r.id}](${r.html_url}) (${r.status})`);
            if (dry_run) {
                return { content: [{ type: "text",
                            text: `**Dry run** — would cancel ${candidates.length} run(s) on ${fullRepo}:\n${rows.join("\n")}` }] };
            }
            const results = [];
            for (const run of candidates) {
                try {
                    await ghRaw(["api", "-X", "POST", `repos/${fullRepo}/actions/runs/${run.id}/cancel`]);
                    results.push(`  ✅ Cancelled [${run.name} #${run.id}](${run.html_url})`);
                }
                catch {
                    results.push(`  ⚠️  Failed to cancel ${run.name} #${run.id}`);
                }
            }
            return { content: [{ type: "text",
                        text: `## Cancelled ${results.length} run(s) on ${fullRepo}\n\n${results.join("\n")}` }] };
        }
        catch (err) {
            return { content: [{ type: "text", text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
    });
}
//# sourceMappingURL=github.js.map