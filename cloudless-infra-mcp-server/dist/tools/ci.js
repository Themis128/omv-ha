import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
const GH_REPOS = {
    "cloudless.gr": "Themis128/cloudless.gr",
    "cloudless-manager": "Themis128/cloudless-manager",
    "omv-ha": "Themis128/omv-ha",
};
function resolveRepo(alias) {
    return GH_REPOS[alias] ?? alias;
}
async function ghJson(args) {
    const { stdout } = await execFileAsync("gh", args, {
        encoding: "utf8",
        timeout: 45_000,
    });
    return JSON.parse(stdout);
}
async function ghRaw(args) {
    const { stdout } = await execFileAsync("gh", args, {
        encoding: "utf8",
        timeout: 45_000,
    });
    return stdout.trim();
}
// ─────────────────────────────────────────────────────────────────────────────
export function registerCiTools(server) {
    // ── gh_ci_summary ──────────────────────────────────────────────────────────
    server.registerTool("gh_ci_summary", {
        title: "CI — Summary dashboard",
        description: `Full CI health dashboard for a repo: per-workflow last run grouped by
FAIL / RUNNING / OK. Detects the GitHub billing-lock pattern (job fails in <15s
with 0 steps). Returns a verdict: HEALTHY | DEGRADED | CRITICAL plus the runner
fleet status.

Use this as the first call in any CI investigation. Equivalent to the /ci-status
slash command but as a structured MCP tool.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            limit: z
                .number()
                .int()
                .min(10)
                .max(200)
                .default(100)
                .describe("How many recent runs to scan to determine per-workflow status. Default 100."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, limit }) => {
        const fullRepo = resolveRepo(repo);
        try {
            // 1. Recent runs
            const runs = await ghJson([
                "run",
                "list",
                "--repo",
                fullRepo,
                "--limit",
                String(limit),
                "--json",
                "databaseId,workflowName,status,conclusion,createdAt,headBranch,url,event",
            ]);
            // 2. Per-workflow: take the most recent run for each workflow name
            const byWorkflow = new Map();
            for (const r of runs) {
                if (!byWorkflow.has(r.workflowName))
                    byWorkflow.set(r.workflowName, r);
            }
            // 3. Billing-lock probe on most recent failure
            let billingLock = false;
            const firstFail = runs.find((r) => r.status === "completed" && r.conclusion === "failure");
            if (firstFail) {
                try {
                    const jobs = await ghJson([
                        "api",
                        `repos/${fullRepo}/actions/runs/${firstFail.databaseId}/jobs`,
                    ]);
                    billingLock = jobs.jobs.some((j) => {
                        if (j.conclusion !== "failure" || (j.steps?.length ?? 0) > 0)
                            return false;
                        const dt = new Date(j.completed_at).getTime() -
                            new Date(j.started_at).getTime();
                        return dt >= 0 && dt < 15_000;
                    });
                }
                catch {
                    /* best-effort */
                }
            }
            // 4. Runner fleet summary
            const runnersData = await ghJson(["api", `repos/${fullRepo}/actions/runners`]);
            const onlineCount = runnersData.runners.filter((r) => r.status === "online").length;
            const busyCount = runnersData.runners.filter((r) => r.busy).length;
            // 5. Bucket by state
            const fail = [];
            const running = [];
            const ok = [];
            for (const [wf, r] of byWorkflow) {
                const ts = new Date(r.createdAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ");
                const line = `\`${r.databaseId}\` **${wf}** | ${r.headBranch} | ${ts}`;
                if (r.status === "in_progress" || r.status === "queued") {
                    running.push(`⏳ ${line}`);
                }
                else if (r.conclusion === "success" || r.conclusion === "skipped") {
                    ok.push(`✅ ${line}`);
                }
                else {
                    fail.push(`❌ ${line} | ${r.conclusion ?? r.status}`);
                }
            }
            // 6. Verdict
            let verdict = "HEALTHY";
            const issues = [];
            if (billingLock) {
                verdict = "CRITICAL";
                issues.push("⚡ **Billing lock** — GitHub-hosted runners disabled. Resolve at github.com/settings/billing.");
            }
            if (onlineCount === 0 && runnersData.total_count > 0) {
                verdict = "CRITICAL";
                issues.push("🔴 All self-hosted runners are offline.");
            }
            if (fail.length > 0 && verdict !== "CRITICAL")
                verdict = "DEGRADED";
            const verdictIcon = verdict === "HEALTHY" ? "✅" : verdict === "DEGRADED" ? "⚠️" : "🛑";
            const parts = [
                `## ${verdictIcon} CI Dashboard — ${fullRepo} — ${verdict}`,
            ];
            if (issues.length > 0)
                parts.push("\n**Critical issues:**\n" + issues.join("\n"));
            parts.push(`\n**Runners:** ${onlineCount}/${runnersData.total_count} online, ${busyCount} busy`);
            if (fail.length > 0)
                parts.push(`\n### ❌ FAILING (${fail.length})\n${fail.join("\n")}`);
            if (running.length > 0)
                parts.push(`\n### ⏳ RUNNING (${running.length})\n${running.join("\n")}`);
            if (ok.length > 0)
                parts.push(`\n### ✅ OK (${ok.length})\n${ok.join("\n")}`);
            parts.push(`\n**Summary:** ${fail.length} failing · ${running.length} running · ${ok.length} OK`);
            return { content: [{ type: "text", text: parts.join("\n") }] };
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
    // ── gh_pr_checks ──────────────────────────────────────────────────────────
    server.registerTool("gh_pr_checks", {
        title: "CI — PR check runs",
        description: `Get all GitHub Actions check runs for a specific pull request.
Returns each check name, status, conclusion, and a direct link to the run.
Use to diagnose why a PR is blocked — identifies exactly which checks are
failing, pending, or skipped.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            pr: z.number().int().describe("Pull request number."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, pr }) => {
        const fullRepo = resolveRepo(repo);
        try {
            // Get PR head SHA and metadata
            const prData = await ghJson([
                "pr",
                "view",
                String(pr),
                "--repo",
                fullRepo,
                "--json",
                "headRefName,headRefOid,title,state,url,statusCheckRollup",
            ]);
            const checks = prData.statusCheckRollup ?? [];
            if (checks.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `## PR #${pr} — ${prData.title}\n\n` +
                                `Branch: \`${prData.headRefName}\` | State: ${prData.state}\n\n` +
                                `No checks found. The PR may have no required status checks configured.`,
                        },
                    ],
                };
            }
            const fail = [];
            const pending = [];
            const pass = [];
            for (const c of checks) {
                const name = c.name ?? c.context ?? "(unknown)";
                const conclusion = c.conclusion ?? c.state ?? c.status ?? "pending";
                const url = c.detailsUrl ?? c.targetUrl ?? "";
                const link = url ? ` ([link](${url}))` : "";
                const line = `**${name}** — ${conclusion}${link}`;
                if (["failure", "error", "timed_out", "action_required"].includes(conclusion)) {
                    fail.push(`❌ ${line}`);
                }
                else if (["success", "neutral", "skipped"].includes(conclusion)) {
                    pass.push(`✅ ${line}`);
                }
                else {
                    pending.push(`⏳ ${line}`);
                }
            }
            const parts = [
                `## PR #${pr} — ${prData.title}`,
                `Branch: \`${prData.headRefName}\` | SHA: \`${prData.headRefOid.slice(0, 8)}\` | [View PR](${prData.url})`,
            ];
            if (fail.length > 0)
                parts.push(`\n### ❌ Failing (${fail.length})\n${fail.join("\n")}`);
            if (pending.length > 0)
                parts.push(`\n### ⏳ Pending (${pending.length})\n${pending.join("\n")}`);
            if (pass.length > 0)
                parts.push(`\n### ✅ Passing (${pass.length})\n${pass.join("\n")}`);
            parts.push(`\n**Total:** ${fail.length} failing · ${pending.length} pending · ${pass.length} passing`);
            return { content: [{ type: "text", text: parts.join("\n") }] };
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
    // ── gh_workflow_failure_logs ───────────────────────────────────────────────
    server.registerTool("gh_workflow_failure_logs", {
        title: "CI — Workflow run failure logs",
        description: `Fetch the failed-step logs for a specific GitHub Actions workflow run.
Equivalent to 'gh run view <id> --log-failed'. Returns the first \`max_lines\`
lines of failure output so you can diagnose the root cause without opening the browser.
Use after gh_ci_summary or gh_pr_checks identifies a failing run ID.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            run_id: z
                .number()
                .int()
                .describe("Workflow run ID (from gh_ci_summary or gh_workflow_list)."),
            max_lines: z
                .number()
                .int()
                .min(10)
                .max(300)
                .default(80)
                .describe("Max log lines to return. Default 80."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, run_id, max_lines }) => {
        const fullRepo = resolveRepo(repo);
        try {
            // Run metadata
            const meta = await ghJson([
                "run",
                "view",
                String(run_id),
                "--repo",
                fullRepo,
                "--json",
                "status,conclusion,displayTitle,workflowName,createdAt,url",
            ]);
            // Failure logs
            let logs = "";
            try {
                logs = await ghRaw([
                    "run",
                    "view",
                    String(run_id),
                    "--repo",
                    fullRepo,
                    "--log-failed",
                ]);
            }
            catch (e) {
                // gh exits non-zero when run didn't fail — surface a helpful message
                const msg = e instanceof Error ? e.message : String(e);
                if (meta.conclusion === "success") {
                    logs = "(Run succeeded — no failure logs.)";
                }
                else {
                    logs = `(Could not fetch logs: ${msg})`;
                }
            }
            const lines = logs.split("\n").slice(0, max_lines);
            const truncated = logs.split("\n").length > max_lines
                ? `\n\n... (truncated at ${max_lines} lines — increase max_lines or view full logs at the URL below)`
                : "";
            return {
                content: [
                    {
                        type: "text",
                        text: `## Failure logs — ${meta.workflowName} run ${run_id}\n` +
                            `**Conclusion:** ${meta.conclusion} | **Title:** ${meta.displayTitle}\n` +
                            `**View:** ${meta.url}\n\n` +
                            `\`\`\`\n${lines.join("\n")}${truncated}\n\`\`\``,
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
    // ── gh_ci_flaky_detector ──────────────────────────────────────────────────
    server.registerTool("gh_ci_flaky_detector", {
        title: "CI — Flaky workflow detector",
        description: `Analyse the last N runs of a workflow to detect intermittent (flaky) failures.
Reports: total runs, success rate, longest failure streak, longest success streak,
and a STABLE / FLAKY / CONSISTENTLY_FAILING verdict.

FLAKY: success rate between 15% and 85% with at least 2 failures.
CONSISTENTLY_FAILING: success rate below 15%.
STABLE: success rate above 85%.

Use to distinguish a genuine regression (consistently failing) from an
environment/race-condition issue (flaky).`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .describe("Repo alias."),
            workflow: z
                .string()
                .describe('Workflow filename to analyse (e.g. "deploy-pi.yml", "e2e.yml").'),
            limit: z
                .number()
                .int()
                .min(5)
                .max(100)
                .default(30)
                .describe("Number of recent runs to analyse. Default 30."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, workflow, limit }) => {
        const fullRepo = resolveRepo(repo);
        try {
            const runs = await ghJson([
                "run",
                "list",
                "--repo",
                fullRepo,
                "--workflow",
                workflow,
                "--limit",
                String(limit),
                "--json",
                "databaseId,status,conclusion,createdAt,headBranch,displayTitle",
            ]);
            // Only completed runs for analysis
            const completed = runs.filter((r) => r.status === "completed");
            if (completed.length < 3) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `⚠️ Only ${completed.length} completed run(s) found for \`${workflow}\` — need at least 3 to detect flakiness.`,
                        },
                    ],
                };
            }
            const successes = completed.filter((r) => r.conclusion === "success" || r.conclusion === "skipped");
            const failures = completed.filter((r) => r.conclusion !== "success" && r.conclusion !== "skipped");
            const successRate = (successes.length / completed.length) * 100;
            // Streak analysis (newest first from gh run list)
            let currentStreak = 0;
            let currentStreakType = completed[0].conclusion === "success" ? "success" : "failure";
            let maxFailStreak = 0;
            let maxSuccessStreak = 0;
            let tempFail = 0;
            let tempSuccess = 0;
            for (const r of completed) {
                const isSuccess = r.conclusion === "success" || r.conclusion === "skipped";
                if (isSuccess) {
                    tempSuccess++;
                    tempFail = 0;
                }
                else {
                    tempFail++;
                    tempSuccess = 0;
                }
                maxFailStreak = Math.max(maxFailStreak, tempFail);
                maxSuccessStreak = Math.max(maxSuccessStreak, tempSuccess);
            }
            // Count current streak (from newest)
            for (const r of completed) {
                const isSuccess = r.conclusion === "success" || r.conclusion === "skipped";
                const type = isSuccess ? "success" : "failure";
                if (type === currentStreakType) {
                    currentStreak++;
                }
                else {
                    break;
                }
            }
            // Verdict
            let verdict;
            let verdictIcon;
            if (successRate >= 85) {
                verdict = "STABLE";
                verdictIcon = "✅";
            }
            else if (successRate < 15) {
                verdict = "CONSISTENTLY_FAILING";
                verdictIcon = "🛑";
            }
            else {
                verdict = "FLAKY";
                verdictIcon = "⚠️";
            }
            // Recent run timeline (newest first, max 20)
            const timeline = completed
                .slice(0, 20)
                .map((r) => {
                const isOk = r.conclusion === "success" || r.conclusion === "skipped";
                const icon = isOk ? "✅" : "❌";
                const ts = new Date(r.createdAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ");
                return `${icon} \`${r.databaseId}\` ${ts} \`${r.headBranch}\` ${r.displayTitle.slice(0, 60)}`;
            })
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: `## ${verdictIcon} Flaky Analysis — \`${workflow}\` on ${fullRepo}\n\n` +
                            `**Verdict:** ${verdict}\n` +
                            `**Runs analysed:** ${completed.length} | **Success rate:** ${successRate.toFixed(0)}%\n` +
                            `**Successes:** ${successes.length} | **Failures:** ${failures.length}\n` +
                            `**Max failure streak:** ${maxFailStreak} | **Max success streak:** ${maxSuccessStreak}\n` +
                            `**Current streak:** ${currentStreak}× ${currentStreakType}\n\n` +
                            `### Recent runs (newest first)\n${timeline}`,
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
    // ── gh_deployment_status ──────────────────────────────────────────────────
    server.registerTool("gh_deployment_status", {
        title: "CI — Live deployment status",
        description: `Show what is currently deployed to production for cloudless.gr.
Reports the most recent successful deploy-pi.yml run: commit SHA, branch, title,
timestamp, and how long ago. Also shows the last failed deploy if the most recent
deploy attempt was not successful.

Use to quickly confirm whether a PR's changes have reached production, or to
identify when a regression was introduced.`,
        inputSchema: z.object({
            repo: z
                .enum(["cloudless.gr", "cloudless-manager", "omv-ha"])
                .default("cloudless.gr")
                .describe("Repo alias. Default: cloudless.gr."),
            workflow: z
                .string()
                .default("deploy-pi.yml")
                .describe('Deploy workflow filename. Default: "deploy-pi.yml".'),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ repo, workflow }) => {
        const fullRepo = resolveRepo(repo);
        try {
            const runs = await ghJson([
                "run",
                "list",
                "--repo",
                fullRepo,
                "--workflow",
                workflow,
                "--limit",
                "20",
                "--json",
                "databaseId,displayTitle,headBranch,headSha,status,conclusion,createdAt,updatedAt,url",
            ]);
            const lastSuccess = runs.find((r) => r.conclusion === "success");
            const lastFailed = runs.find((r) => r.conclusion === "failure");
            const inProgress = runs.find((r) => r.status === "in_progress" || r.status === "queued");
            const ago = (ts) => {
                const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60_000);
                if (mins < 60)
                    return `${mins}m ago`;
                if (mins < 1440)
                    return `${Math.floor(mins / 60)}h ago`;
                return `${Math.floor(mins / 1440)}d ago`;
            };
            const parts = [
                `## 🚀 Deployment Status — ${fullRepo} / \`${workflow}\``,
            ];
            if (inProgress) {
                parts.push(`\n⏳ **Deploy in progress** — run \`${inProgress.databaseId}\` | ` +
                    `\`${inProgress.headSha.slice(0, 8)}\` | ${ago(inProgress.createdAt)}`);
            }
            if (lastSuccess) {
                const ts = new Date(lastSuccess.updatedAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ");
                parts.push(`\n✅ **Live (last successful deploy)**\n` +
                    `  SHA: \`${lastSuccess.headSha.slice(0, 8)}\`\n` +
                    `  Branch: \`${lastSuccess.headBranch}\`\n` +
                    `  Title: ${lastSuccess.displayTitle}\n` +
                    `  Deployed: ${ts} UTC (${ago(lastSuccess.updatedAt)})\n` +
                    `  Run: [#${lastSuccess.databaseId}](${lastSuccess.url})`);
            }
            else {
                parts.push(`\n⚠️ No successful deploy found in the last 20 runs.`);
            }
            if (lastFailed && lastFailed.databaseId !== lastSuccess?.databaseId) {
                const ts = new Date(lastFailed.createdAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ");
                parts.push(`\n❌ **Last failed deploy**\n` +
                    `  SHA: \`${lastFailed.headSha.slice(0, 8)}\`\n` +
                    `  ${ts} UTC (${ago(lastFailed.createdAt)}) | Run: [#${lastFailed.databaseId}](${lastFailed.url})\n` +
                    `  Use \`gh_workflow_failure_logs\` with run_id \`${lastFailed.databaseId}\` to diagnose.`);
            }
            // Is latest deploy the live one?
            if (lastSuccess &&
                runs[0]?.databaseId !== lastSuccess.databaseId &&
                !inProgress) {
                parts.push(`\n⚠️ **The latest run is NOT the live deploy.** A newer run (${runs[0]?.conclusion}) ` +
                    `may have overwritten or failed after the last success.`);
            }
            return { content: [{ type: "text", text: parts.join("\n") }] };
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
}
//# sourceMappingURL=ci.js.map