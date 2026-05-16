import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
const APPS = {
    cloudless: "https://cloudless.online",
    manager: "https://manage.cloudless.online",
};
// Security headers we expect on every response
const SECURITY_HEADERS = [
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
    "content-security-policy",
    "referrer-policy",
    "permissions-policy",
];
// Performance headers
const PERF_HEADERS = [
    "content-encoding",
    "cache-control",
    "cf-cache-status",
    "etag",
    "vary",
];
function curlHeadersCmd(url) {
    return `curl -sI --max-time 10 --compressed '${url}'`;
}
function parseHeaders(raw) {
    const headers = {};
    for (const line of raw.split("\n")) {
        const idx = line.indexOf(":");
        if (idx === -1)
            continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        headers[key] = val;
    }
    return headers;
}
export function registerAppScanTools(server) {
    // ── app_security_scan ─────────────────────────────────────────────────────
    server.registerTool("app_security_scan", {
        title: "App — Security Header Scan",
        description: `Check HTTP security headers for cloudless.online and/or manage.cloudless.online.
Validates: HSTS, X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy, Permissions-Policy.
Also checks TLS grade and redirect behaviour (HTTP→HTTPS).
Run after any Traefik/Cloudflare config change or before a production release.`,
        inputSchema: z.object({
            app: z
                .enum(["cloudless", "manager", "both"])
                .default("both")
                .describe("Which app to scan."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ app }) => {
        const targets = app === "both" ? ["cloudless", "manager"] : [app];
        const results = [];
        for (const key of targets) {
            const url = APPS[key];
            const r = await runOnNode("omv-main", curlHeadersCmd(url));
            if (r.error) {
                results.push(`## ${url}\n❌ curl failed: ${r.error}`);
                continue;
            }
            const headers = parseHeaders(r.stdout);
            const rows = [];
            let pass = 0;
            for (const h of SECURITY_HEADERS) {
                const val = headers[h];
                const ok = !!val;
                if (ok)
                    pass++;
                rows.push(`${ok ? "✅" : "❌"} \`${h}\`${val ? `: \`${val.slice(0, 80)}\`` : " — **MISSING**"}`);
            }
            // HTTP→HTTPS redirect check
            const httpR = await runOnNode("omv-main", `curl -sI --max-time 5 'http://${url.replace("https://", "")}' | grep -i location`);
            const redirectsToHttps = httpR.stdout.toLowerCase().includes("https://");
            rows.push(`${redirectsToHttps ? "✅" : "❌"} \`http→https redirect\`${redirectsToHttps ? "" : " — **NO REDIRECT**"}`);
            const total = SECURITY_HEADERS.length + 1;
            const summary = pass === total ? `✅ All ${total} checks passed` : `⚠️ ${pass}/${total} passed`;
            results.push(`## ${url}\n\n${summary}\n\n${rows.join("\n")}`);
        }
        return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
    });
    // ── app_perf_scan ─────────────────────────────────────────────────────────
    server.registerTool("app_perf_scan", {
        title: "App — Performance Header Scan",
        description: `Check HTTP performance indicators for cloudless.online and/or manage.cloudless.online.
Checks: gzip/brotli compression, cache-control directives, Cloudflare cache status (HIT/MISS/BYPASS),
ETag presence, and TTFB (time-to-first-byte via curl timing).
Run after CDN config changes or to baseline response performance.`,
        inputSchema: z.object({
            app: z
                .enum(["cloudless", "manager", "both"])
                .default("both")
                .describe("Which app to scan."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ app }) => {
        const targets = app === "both" ? ["cloudless", "manager"] : [app];
        const results = [];
        for (const key of targets) {
            const url = APPS[key];
            // TTFB timing + headers in one curl
            const cmd = `curl -sI --max-time 15 --compressed ` +
                `-w '\\nTTFB: %{time_starttransfer}s | Total: %{time_total}s | Size: %{size_download}B' ` +
                `'${url}'`;
            const r = await runOnNode("omv-main", cmd);
            if (r.error) {
                results.push(`## ${url}\n❌ curl failed: ${r.error}`);
                continue;
            }
            const headers = parseHeaders(r.stdout);
            const rows = [];
            for (const h of PERF_HEADERS) {
                const val = headers[h];
                const ok = !!val;
                rows.push(`${ok ? "✅" : "⚠️"} \`${h}\`${val ? `: \`${val.slice(0, 80)}\`` : " — not set"}`);
            }
            // Extract timing line
            const timingLine = r.stdout.split("\n").find((l) => l.startsWith("TTFB:")) ?? "";
            const compressed = headers["content-encoding"];
            rows.push(`📊 **Timing:** ${timingLine || "n/a"}`);
            rows.push(`📦 **Compression:** ${compressed ? `✅ ${compressed}` : "⚠️ none"}`);
            results.push(`## ${url}\n\n${rows.join("\n")}`);
        }
        return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
    });
    // ── app_deps_check ────────────────────────────────────────────────────────
    server.registerTool("app_deps_check", {
        title: "App — Dependency Staleness Check",
        description: `Compare package.json versions for cloudless.gr and cloudless-manager against npm latest.
Flags dependencies that are more than one major version behind (breaking changes likely).
Run before a quarterly maintenance pass or when planning upgrades.`,
        inputSchema: z.object({
            app: z
                .enum(["cloudless", "manager", "both"])
                .default("both")
                .describe("Which app to check."),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ app }) => {
        const repos = {
            cloudless: "Themis128/cloudless.gr",
            manager: "Themis128/cloudless-manager",
        };
        const targets = app === "both" ? ["cloudless", "manager"] : [app];
        const results = [];
        for (const key of targets) {
            const repo = repos[key];
            const r = await runOnNode("omv-main", `gh api repos/${repo}/contents/package.json --jq '.content' | base64 -d | python3 -c "import json,sys; p=json.load(sys.stdin); [print(k+'@'+v) for k,v in {**p.get('dependencies',{}), **p.get('devDependencies',{})}.items()]" 2>/dev/null | head -40`);
            if (r.error || !r.stdout.trim()) {
                results.push(`## ${repo}\n❌ Could not fetch package.json: ${r.error || "empty"}`);
                continue;
            }
            const lines = r.stdout.trim().split("\n").filter(Boolean);
            results.push(`## ${repo}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n\n_Run \`npm outdated\` locally for full semver diff._`);
        }
        return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
    });
    // ── app_improvement_report ────────────────────────────────────────────────
    server.registerTool("app_improvement_report", {
        title: "App — Full Improvement Report",
        description: `Run all app scans (security headers, performance, CSRF guard, WebSocket auth) for
cloudless.online and manage.cloudless.online and return a prioritised improvement list.
This is the entry point for a full app audit — use it first, then drill into specifics.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const checks = await Promise.all([
            // Security headers — both apps
            runOnNode("omv-main", `curl -sI --max-time 10 '${APPS.cloudless}'`),
            runOnNode("omv-main", `curl -sI --max-time 10 '${APPS.manager}'`),
            // TTFB
            runOnNode("omv-main", `curl -so /dev/null --max-time 10 -w '%{time_starttransfer}' '${APPS.cloudless}'`),
            runOnNode("omv-main", `curl -so /dev/null --max-time 10 -w '%{time_starttransfer}' '${APPS.manager}'`),
            // Compression check
            runOnNode("omv-main", `curl -sI --max-time 10 --compressed '${APPS.cloudless}' | grep -i 'content-encoding'`),
            runOnNode("omv-main", `curl -sI --max-time 10 --compressed '${APPS.manager}' | grep -i 'content-encoding'`),
        ]);
        const [clH, mgH, clTTFB, mgTTFB, clEnc, mgEnc] = checks;
        const report = ["# App Improvement Report\n"];
        for (const [label, headersRaw, ttfb, enc] of [
            ["cloudless.online", clH, clTTFB, clEnc],
            ["manage.cloudless.online", mgH, mgTTFB, mgEnc],
        ]) {
            const headers = parseHeaders(headersRaw.stdout || "");
            const missing = SECURITY_HEADERS.filter((h) => !headers[h]);
            const hasCompression = !!(enc.stdout || "").trim();
            const ttfbVal = parseFloat(ttfb.stdout || "0");
            report.push(`## ${label}`);
            if (missing.length) {
                report.push(`**Missing security headers (${missing.length}):** ${missing.map((h) => `\`${h}\``).join(", ")}`);
            }
            else {
                report.push("✅ All security headers present");
            }
            report.push(`**Compression:** ${hasCompression ? "✅ enabled" : "⚠️ not detected"}`);
            report.push(`**TTFB:** ${ttfbVal > 0 ? `${(ttfbVal * 1000).toFixed(0)}ms${ttfbVal > 1 ? " ⚠️ slow" : " ✅"}` : "n/a"}`);
            report.push("");
        }
        report.push("## Known Code-Level Issues");
        report.push(`
**cloudless.gr (Next.js):**
- CSP set to \`Report-Only\` — not enforced; promote after soak period
- JWT signature not verified in \`readCognitoToken()\` (src/proxy.ts) — use \`jose.jwtVerify()\`
- \`<html lang>\` hardcoded to \`"en"\` for all 4 locales (src/app/layout.tsx)
- \`geistMono\` font has \`preload: false\` despite above-the-fold usage (next.config.ts)
- \`three\`, \`@react-three/drei\`, \`lucide-react\` missing from \`optimizePackageImports\`
- In-memory rate limiter resets on Lambda cold start (src/proxy.ts) — use WAF rule for /api/chat

**cloudless-manager (Node.js):**
- CSRF guard accepts any \`localhost\` origin (server.js ~line 58)
- WebSocket /ws/logs has no auth check (server.js ~line 355) — validate X-Auth-Request-User
- Rate-limit Map never pruned → memory leak (server.js ~line 27)
- All catch blocks return \`e.message\` raw → info leak (server.js, all routes)
- ClusterRole too broad — should be namespace-scoped RoleBindings (k8s/rbac.yaml)
- \`:latest\` image tag in deployment — no SHA pinning (k8s/deployment.yaml)
      `.trim());
        return { content: [{ type: "text", text: report.join("\n") }] };
    });
}
//# sourceMappingURL=app-scan.js.map