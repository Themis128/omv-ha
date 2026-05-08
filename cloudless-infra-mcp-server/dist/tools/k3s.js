import { z } from "zod";
import { runOnNode } from "../services/ssh.js";
// K3s runs on OMV main (Pi 5, 192.168.1.128)
const K3S_NODE = "omv-main";
const KUBECTL = "sudo k3s kubectl";
export function registerK3sTools(server) {
    // ── k3s_get_cluster_status ────────────────────────────────────────────────
    server.registerTool("k3s_get_cluster_status", {
        title: "K3s Cluster Status",
        description: `Get a full status snapshot of the K3s Kubernetes cluster on OMV main (Pi 5).
Returns: cluster nodes, all pods across namespaces, all services, and K3s systemd service status.
Use first to assess overall cluster health.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const cmd = `echo '=== Nodes ===' && ${KUBECTL} get nodes -o wide` +
            ` && echo '=== Pods (all namespaces) ===' && ${KUBECTL} get pods -A` +
            ` && echo '=== Services ===' && ${KUBECTL} get services -A` +
            ` && echo '=== K3s Service ===' && systemctl is-active k3s && systemctl status k3s --no-pager -l | tail -5`;
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error
            ? `❌ Failed to connect to OMV main: ${r.error}`
            : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── k3s_get_pods ──────────────────────────────────────────────────────────
    server.registerTool("k3s_get_pods", {
        title: "K3s List Pods",
        description: `List pods in the K3s cluster, optionally filtered by namespace.
Returns pod names, namespace, status, restart count, and age.`,
        inputSchema: z.object({
            namespace: z
                .string()
                .optional()
                .describe('Kubernetes namespace to filter by (e.g., "home-assistant", "cloudless"). Omit for all namespaces.'),
            show_events: z
                .boolean()
                .default(false)
                .describe("Also show recent events (useful for debugging)"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ namespace, show_events }) => {
        const nsFlag = namespace ? `-n ${namespace}` : "-A";
        let cmd = `${KUBECTL} get pods ${nsFlag} -o wide`;
        if (show_events) {
            cmd +=
                ` && echo '=== Recent Events ===' && ${KUBECTL} get events ${nsFlag} --sort-by='.lastTimestamp' | tail -20`;
        }
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── k3s_get_pod_logs ─────────────────────────────────────────────────────
    server.registerTool("k3s_get_pod_logs", {
        title: "K3s Pod Logs",
        description: `Fetch logs from a K3s pod by namespace and label selector or pod name.
Examples:
- Home Assistant: namespace="home-assistant", selector="app=home-assistant"
- cloudless.gr: namespace="cloudless", selector="app=cloudless"
Returns the last N lines of logs.`,
        inputSchema: z.object({
            namespace: z.string().describe("Kubernetes namespace"),
            selector: z
                .string()
                .optional()
                .describe('Label selector, e.g. "app=home-assistant"'),
            pod_name: z
                .string()
                .optional()
                .describe("Exact pod name (alternative to selector)"),
            tail: z
                .number()
                .int()
                .min(10)
                .max(1000)
                .default(100)
                .describe("Number of log lines to return"),
            follow: z
                .boolean()
                .default(false)
                .describe("Stream live logs (limited to 5s)"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ namespace, selector, pod_name, tail }) => {
        let target;
        if (pod_name) {
            target = pod_name;
        }
        else if (selector) {
            target = `-l ${selector}`;
        }
        else {
            return {
                content: [
                    {
                        type: "text",
                        text: "❌ Provide either selector or pod_name.",
                    },
                ],
            };
        }
        const cmd = `${KUBECTL} logs -n ${namespace} ${target} --tail=${tail} 2>&1`;
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── k3s_restart_deployment ────────────────────────────────────────────────
    server.registerTool("k3s_restart_deployment", {
        title: "K3s Restart Deployment",
        description: `Perform a rolling restart of a K3s deployment.
Common deployments:
- Home Assistant: namespace="home-assistant", deployment="home-assistant"
- cloudless.gr app: namespace="cloudless", deployment="cloudless"
Returns the rollout status after restart.`,
        inputSchema: z.object({
            namespace: z.string().describe("Kubernetes namespace"),
            deployment: z.string().describe("Deployment name to restart"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ namespace, deployment }) => {
        const cmd = `${KUBECTL} rollout restart deployment/${deployment} -n ${namespace}` +
            ` && ${KUBECTL} rollout status deployment/${deployment} -n ${namespace} --timeout=60s`;
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── k3s_check_ha ─────────────────────────────────────────────────────────
    server.registerTool("k3s_check_ha", {
        title: "Home Assistant Status",
        description: `Check Home Assistant pod, logs, and service in the K3s cluster.
Returns: pod status, last 50 log lines, service port, and recent events.
Shortcut — no need to know the exact pod name or namespace.`,
        inputSchema: z.object({
            tail: z
                .number()
                .int()
                .min(10)
                .max(500)
                .default(50)
                .describe("Number of log lines to include"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ tail }) => {
        const cmd = `echo '=== Home Assistant Pod ===' && ${KUBECTL} get pods -n home-assistant` +
            ` && echo '=== Service ===' && ${KUBECTL} get service -n home-assistant` +
            ` && echo '=== Logs (last ${tail} lines) ===' && ${KUBECTL} logs -n home-assistant -l app=home-assistant --tail=${tail} 2>&1` +
            ` && echo '=== Events ===' && ${KUBECTL} get events -n home-assistant --sort-by='.lastTimestamp' | tail -10`;
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── k3s_check_cloudless_app ───────────────────────────────────────────────
    server.registerTool("k3s_check_cloudless_app", {
        title: "Check cloudless.online App (K3s Deployment)",
        description: `Check the cloudless.online Next.js app running as a K3s deployment in the cloudless namespace.
Returns: pod status, service, ingress, health check via Traefik VIP, and current IPv6 address.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async () => {
        const cmd = `echo '=== Pods ===' && ${KUBECTL} get pods -n cloudless -o wide` +
            ` && echo '=== Service ===' && ${KUBECTL} get service -n cloudless` +
            ` && echo '=== Ingress ===' && ${KUBECTL} get ingress -n cloudless` +
            ` && echo '=== Health Check ===' && curl -sk -H 'Host: cloudless.online' https://localhost:18443/api/health 2>&1 | head -20 || echo 'health check failed'` +
            ` && echo '=== Current IPv6 ===' && ip -6 addr show | grep 'scope global' | awk '{print $2}' | cut -d/ -f1`;
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
    // ── k3s_describe_resource ─────────────────────────────────────────────────
    server.registerTool("k3s_describe_resource", {
        title: "K3s Describe Resource",
        description: `Get detailed description of a K3s resource (pod, deployment, service, ingress, etc.).
Equivalent to: kubectl describe <kind> <name> -n <namespace>
Useful for debugging pod scheduling issues, CrashLoopBackOff, image pull errors, etc.`,
        inputSchema: z.object({
            kind: z
                .enum([
                "pod",
                "deployment",
                "service",
                "ingress",
                "pvc",
                "configmap",
                "node",
            ])
                .describe("Resource kind"),
            name: z.string().describe("Resource name"),
            namespace: z
                .string()
                .optional()
                .describe("Namespace (omit for cluster-scoped resources like nodes)"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ kind, name, namespace }) => {
        const nsFlag = namespace ? `-n ${namespace}` : "";
        const cmd = `${KUBECTL} describe ${kind} ${name} ${nsFlag}`;
        const r = await runOnNode(K3S_NODE, cmd);
        const text = r.error ? `❌ ${r.error}` : "```\n" + r.stdout + "\n```";
        return { content: [{ type: "text", text }] };
    });
}
//# sourceMappingURL=k3s.js.map