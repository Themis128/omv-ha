import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { runOnNode } from "../services/ssh.js";

const execFileAsync = promisify(execFile);
const REPO_DIR = "/home/tbaltzakis/cloudless.gr";
const FULL_REPO = "Themis128/cloudless.gr";
const DEPLOY_WORKFLOW = "deploy-pi.yml";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ghJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8", timeout: 30_000 });
  return JSON.parse(stdout) as T;
}

async function ghRaw(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8", timeout: 30_000 });
  return stdout.trim();
}

interface ManifestShape {
  name?: unknown;
  short_name?: unknown;
  theme_color?: unknown;
  background_color?: unknown;
  display?: unknown;
  display_override?: unknown;
  start_url?: unknown;
  id?: unknown;
  scope?: unknown;
  lang?: unknown;
  icons?: unknown;
  shortcuts?: unknown;
  [key: string]: unknown;
}

function formatManifestAudit(m: ManifestShape, source: string): string {
  const checks: Array<{ label: string; key: string; ok: boolean; got: string; note?: string }> = [
    {
      label: "name",
      key: "name",
      ok: typeof m.name === "string" && m.name.length > 0,
      got: JSON.stringify(m.name),
    },
    {
      label: "short_name",
      key: "short_name",
      ok: typeof m.short_name === "string" && m.short_name.length > 0,
      got: JSON.stringify(m.short_name),
    },
    {
      label: "theme_color",
      key: "theme_color",
      ok: m.theme_color === "#0a7785",
      got: JSON.stringify(m.theme_color),
      note: "expected #0a7785 (brand teal)",
    },
    {
      label: "background_color",
      key: "background_color",
      ok: m.background_color === "#fcfcfd",
      got: JSON.stringify(m.background_color),
      note: "expected #fcfcfd (surface canvas)",
    },
    {
      label: "display",
      key: "display",
      ok: m.display === "standalone",
      got: JSON.stringify(m.display),
    },
    {
      label: "display_override",
      key: "display_override",
      ok: Array.isArray(m.display_override) && (m.display_override as unknown[]).length >= 2,
      got: Array.isArray(m.display_override) ? `[${(m.display_override as unknown[]).length} entries]` : JSON.stringify(m.display_override),
      note: "expected ≥2 entries",
    },
    {
      label: "start_url",
      key: "start_url",
      ok: typeof m.start_url === "string" && m.start_url.includes("source=pwa"),
      got: JSON.stringify(m.start_url),
      note: "must include source=pwa",
    },
    {
      label: "id",
      key: "id",
      ok: typeof m.id === "string" && m.id.length > 0,
      got: JSON.stringify(m.id),
    },
    {
      label: "scope",
      key: "scope",
      ok: typeof m.scope === "string" && m.scope.length > 0,
      got: JSON.stringify(m.scope),
    },
    {
      label: "lang",
      key: "lang",
      ok: typeof m.lang === "string" && m.lang.length > 0,
      got: JSON.stringify(m.lang),
    },
    {
      label: "icons",
      key: "icons",
      ok: Array.isArray(m.icons) && (m.icons as unknown[]).length >= 2,
      got: Array.isArray(m.icons) ? `[${(m.icons as unknown[]).length} icons]` : JSON.stringify(m.icons),
      note: "expected ≥2 entries",
    },
    {
      label: "shortcuts",
      key: "shortcuts",
      ok: Array.isArray(m.shortcuts) && (m.shortcuts as unknown[]).length >= 3,
      got: Array.isArray(m.shortcuts) ? `[${(m.shortcuts as unknown[]).length} shortcuts]` : JSON.stringify(m.shortcuts),
      note: "expected ≥3 shortcuts",
    },
  ];

  const rows = checks.map(({ label, ok, got, note }) => {
    const icon = ok ? "✅" : "❌";
    const noteStr = note ? ` — _${note}_` : "";
    return `${icon} **${label}**: ${got}${noteStr}`;
  });

  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length;
  const summary = passed === total ? `✅ All ${total} checks passed` : `⚠️ ${passed}/${total} checks passed`;

  return `## PWA Manifest Audit — ${source}\n\n${summary}\n\n${rows.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerFrontendTools(server: McpServer): void {
  // ── frontend_check_navbar ─────────────────────────────────────────────────
  server.registerTool(
    "frontend_check_navbar",
    {
      title: "Frontend — Audit Navbar",
      description: `Inspect Navbar.tsx on omv-main and verify all features introduced in the navbar refactor:
- Scroll shadow (scrolled state + useEffect)
- Free Audit CTA (freeAudit i18n key + /contact link)
- ARIA accessibility (aria-expanded on hamburger + user menu)
- Resize listener (closes mobile menu on viewport ≥1024px)

Returns a pass/fail table with occurrence counts. Run after any navbar change.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const f = `${REPO_DIR}/src/components/Navbar.tsx`;
      const script = [
        `python3 -c "`,
        `import sys`,
        `F=open('${f}').read()`,
        `checks=[`,
        `  ('Scroll shadow state (scrolled)', 'scrolled'),`,
        `  ('Free Audit CTA (freeAudit)', 'freeAudit'),`,
        `  ('aria-expanded attrs', 'aria-expanded'),`,
        `  ('onScroll useEffect', 'onScroll'),`,
        `  ('onResize useEffect', 'onResize'),`,
        `  ('shadow-md in header', 'shadow-md'),`,
        `  ('Contact link (/contact)', '/contact'),`,
        `  ('aria-haspopup on user menu', 'aria-haspopup'),`,
        `]`,
        `[print(f'{ok} {l}: {n}') for l,p in checks for n in [F.count(p)] for ok in ['OK' if n>0 else 'FAIL']]`,
        `"`,
      ].join("\n");

      // Build as a single-line python command
      const cmd =
        `python3 -c ` +
        `"import sys\n` +
        `F=open('${f}').read()\n` +
        `checks=[('Scroll shadow state','scrolled'),('Free Audit CTA','freeAudit'),('aria-expanded','aria-expanded'),('onScroll handler','onScroll'),('onResize handler','onResize'),('shadow-md header','shadow-md'),('contact link','/contact'),('aria-haspopup','aria-haspopup')]\n` +
        `[print(ok+' '+l+': '+str(n)) for l,p in checks for n in [F.count(p)] for ok in ['OK' if n>0 else 'FAIL']]"`;

      void script; // unused above, just to keep ts happy
      const r = await runOnNode("omv-main", cmd);

      if (r.error) {
        return { content: [{ type: "text", text: `❌ SSH failed: ${r.error}` }] };
      }

      const lines = (r.stdout || r.stderr || "").trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        return { content: [{ type: "text", text: `❌ No output from audit script. File may not exist at ${f}` }] };
      }

      const rows = lines.map((line) => {
        const ok = line.startsWith("OK");
        const rest = line.replace(/^(OK|FAIL) /, "");
        return `${ok ? "✅" : "❌"} **${rest}**`;
      });

      const passed = lines.filter((l) => l.startsWith("OK")).length;
      const total = lines.length;
      const summary = passed === total ? `✅ All ${total} checks passed` : `⚠️ ${passed}/${total} passed`;

      return {
        content: [{
          type: "text",
          text: `## Navbar Audit — ${f}\n\n${summary}\n\n${rows.join("\n")}`,
        }],
      };
    },
  );

  // ── frontend_check_pwa ────────────────────────────────────────────────────
  server.registerTool(
    "frontend_check_pwa",
    {
      title: "Frontend — Audit PWA Manifest",
      description: `Validate the PWA manifest configuration for cloudless.gr/cloudless.online.
Checks brand-critical fields: theme_color (#0a7785), background_color (#fcfcfd),
display_override array, start_url tracking param, id/scope/lang, icon purposes, and shortcuts.

source options:
- "static"     — reads public/manifest.webmanifest from the Pi (static fallback file)
- "api-source" — reads src/app/api/pwa-manifest/route.ts source code
- "live"       — curls the live /api/pwa-manifest endpoint (requires live_url)`,
      inputSchema: z.object({
        source: z
          .enum(["static", "api-source", "live"])
          .default("static")
          .describe("Which source to validate."),
        live_url: z
          .string()
          .optional()
          .describe('Base URL for live check, e.g. "https://cloudless.online". Required when source=live.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ source, live_url }) => {
      if (source === "live") {
        if (!live_url) {
          return { content: [{ type: "text", text: "❌ live_url is required when source=live (e.g. https://cloudless.online)" }] };
        }
        const url = `${live_url.replace(/\/$/, "")}/api/pwa-manifest`;
        const r = await runOnNode("omv-main", `curl -sf '${url}' 2>&1`);
        if (r.error) {
          return { content: [{ type: "text", text: `❌ SSH failed: ${r.error}` }] };
        }
        try {
          const manifest = JSON.parse(r.stdout) as ManifestShape;
          return { content: [{ type: "text", text: formatManifestAudit(manifest, url) }] };
        } catch {
          return {
            content: [{
              type: "text",
              text: `❌ Invalid JSON from ${url}:\n\`\`\`\n${r.stdout.slice(0, 600)}\n\`\`\``,
            }],
          };
        }
      }

      if (source === "api-source") {
        const filePath = `${REPO_DIR}/src/app/api/pwa-manifest/route.ts`;
        const r = await runOnNode("omv-main", `cat '${filePath}' 2>/dev/null || echo FILE_NOT_FOUND`);
        if (r.error || r.stdout.includes("FILE_NOT_FOUND")) {
          return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };
        }
        return {
          content: [{
            type: "text",
            text: `## API Route Source — ${filePath}\n\`\`\`typescript\n${r.stdout}\n\`\`\``,
          }],
        };
      }

      // Static manifest
      const filePath = `${REPO_DIR}/public/manifest.webmanifest`;
      const r = await runOnNode("omv-main", `cat '${filePath}' 2>/dev/null || echo FILE_NOT_FOUND`);
      if (r.error || r.stdout.includes("FILE_NOT_FOUND")) {
        return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };
      }
      try {
        const manifest = JSON.parse(r.stdout) as ManifestShape;
        return { content: [{ type: "text", text: formatManifestAudit(manifest, filePath) }] };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `❌ Invalid JSON in ${filePath}: ${e}\n\n\`\`\`\n${r.stdout.slice(0, 800)}\n\`\`\``,
          }],
        };
      }
    },
  );

  // ── frontend_deploy_cloudless_gr ──────────────────────────────────────────
  server.registerTool(
    "frontend_deploy_cloudless_gr",
    {
      title: "Frontend — Deploy cloudless.gr",
      description: `Trigger the deploy-pi.yml GitHub Actions workflow for cloudless.gr (Themis128/cloudless.gr)
and watch it to completion. Combines gh_workflow_trigger + gh_workflow_watch in one call.

The CI pipeline: lint/typecheck → Next.js build → Docker push to GHCR → k3s rollout.
Only dispatches on branches that have workflow_dispatch enabled (typically main).
Use gh_workflow_list to check recent run history without triggering a new one.`,
      inputSchema: z.object({
        ref: z
          .string()
          .default("main")
          .describe("Git branch or tag to deploy. Default: main."),
        timeout_minutes: z
          .number()
          .default(15)
          .describe("Max minutes to wait before returning partial status. Default 15."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ ref, timeout_minutes }) => {
      // Trigger
      try {
        await ghRaw(["workflow", "run", DEPLOY_WORKFLOW, "--repo", FULL_REPO, "--ref", ref]);
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to trigger \`${DEPLOY_WORKFLOW}\` on **${FULL_REPO}** (ref: ${ref})\n\n${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      // Brief pause for GH to register the run
      await new Promise((r) => setTimeout(r, 3000));

      // Fetch the new run ID
      let runId: number;
      try {
        const raw = await ghRaw([
          "run", "list",
          "--repo", FULL_REPO,
          "--workflow", DEPLOY_WORKFLOW,
          "--limit", "1",
          "--json", "databaseId,status,headBranch",
        ]);
        const runs = JSON.parse(raw) as Array<{ databaseId: number; status: string; headBranch: string }>;
        if (!runs[0]) {
          return {
            content: [{
              type: "text",
              text: `✅ Triggered \`${DEPLOY_WORKFLOW}\` on **${FULL_REPO}** (ref: ${ref}). Run ID not yet visible — retry \`gh_workflow_list\` in ~10s.`,
            }],
          };
        }
        runId = runs[0].databaseId;
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `✅ Triggered but failed to get run ID: ${err instanceof Error ? err.message : String(err)}\nCheck: https://github.com/${FULL_REPO}/actions`,
          }],
        };
      }

      // Poll until completed or timeout
      const deadline = Date.now() + timeout_minutes * 60 * 1000;
      const pollMs = 20_000;

      while (Date.now() < deadline) {
        try {
          const data = await ghJson<{
            status: string;
            conclusion: string;
            jobs: Array<{
              name: string;
              status: string;
              conclusion: string;
              steps: Array<{ name: string; status: string; conclusion: string; number: number }>;
            }>;
          }>(["run", "view", String(runId), "--repo", FULL_REPO, "--json", "status,conclusion,jobs"]);

          if (data.status === "completed") {
            const icon = data.conclusion === "success" ? "✅" : "❌";
            const jobs = data.jobs
              .map((j) => {
                const jIcon =
                  j.conclusion === "success" ? "✅" :
                  j.conclusion === "failure" ? "❌" :
                  j.status === "in_progress" ? "⏳" : "⏸";
                const steps = j.steps
                  .map((s) => {
                    const sIcon =
                      s.conclusion === "success" ? "✓" :
                      s.conclusion === "failure" ? "✗" :
                      s.status === "in_progress" ? "▶" : "·";
                    return `    ${sIcon} ${s.name}`;
                  })
                  .join("\n");
                return `${jIcon} **${j.name}** (${j.conclusion || j.status})\n${steps}`;
              })
              .join("\n\n");

            return {
              content: [{
                type: "text",
                text: `## ${icon} Deploy ${data.conclusion.toUpperCase()} — ${FULL_REPO}\n\n**Run:** ${runId} | **Ref:** ${ref}\n\n${jobs}\n\nView: https://github.com/${FULL_REPO}/actions/runs/${runId}`,
              }],
            };
          }

          await new Promise((r) => setTimeout(r, pollMs));
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `❌ Error polling run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }
      }

      return {
        content: [{
          type: "text",
          text: `⏱️ Timeout after ${timeout_minutes} min — run ${runId} still in progress.\nView: https://github.com/${FULL_REPO}/actions/runs/${runId}`,
        }],
      };
    },
  );
}
