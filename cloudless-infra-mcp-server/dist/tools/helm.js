import { z } from "zod";
import { runOnNode, uploadFile } from "../services/ssh.js";
const K3S_NODE = "omv-main";
const KUBECONFIG = "KUBECONFIG=/etc/rancher/k3s/k3s.yaml";
export function registerHelmTools(server) {
    // ── helm_deploy_chart ────────────────────────────────────────────────────
    server.registerTool("helm_deploy_chart", {
        title: "Helm Deploy Chart",
        description: `Install or upgrade a Helm chart on the k3s cluster.
Uploads a local values file via SFTP to omv-main, then runs helm upgrade --install.
Returns helm output including status and deployed resources.`,
        inputSchema: z.object({
            release: z.string().describe("Helm release name"),
            chart: z
                .string()
                .describe("Chart reference e.g. prometheus-community/kube-prometheus-stack"),
            namespace: z.string().describe("Target Kubernetes namespace"),
            valuesFilePath: z
                .string()
                .optional()
                .describe("Absolute local path to values YAML file"),
            extraArgs: z
                .string()
                .optional()
                .describe("Additional helm args e.g. --timeout 10m"),
            createNamespace: z
                .boolean()
                .default(true)
                .describe("Create namespace if missing"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ release, chart, namespace, valuesFilePath, extraArgs, createNamespace, }) => {
        let valuesFlag = "";
        if (valuesFilePath) {
            const remotePath = `/tmp/helm-values-${release}-${Date.now()}.yaml`;
            const uploadResult = await uploadFile(K3S_NODE, valuesFilePath, remotePath);
            if (uploadResult.code !== 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `SFTP upload failed: ${uploadResult.stderr}`,
                        },
                    ],
                };
            }
            valuesFlag = `-f ${remotePath}`;
        }
        const nsFlag = createNamespace ? "--create-namespace" : "";
        const cmd = `sudo ${KUBECONFIG} helm upgrade --install ${release} ${chart} \
        --namespace ${namespace} ${nsFlag} \
        ${valuesFlag} \
        ${extraArgs ?? ""} \
        --timeout 15m --atomic 2>&1`;
        const result = await runOnNode(K3S_NODE, cmd);
        const status = result.code === 0 ? "SUCCESS" : "FAILED";
        return {
            content: [
                {
                    type: "text",
                    text: `## Helm Deploy: ${release} → ${chart}\n**Status:** ${status}\n\n\`\`\`\n${result.stdout}\n${result.stderr}\n\`\`\``,
                },
            ],
        };
    });
    // ── helm_list ────────────────────────────────────────────────────────────
    server.registerTool("helm_list", {
        title: "List Helm Releases",
        description: "List all Helm releases across all namespaces on the k3s cluster.",
        inputSchema: z.object({
            namespace: z
                .string()
                .optional()
                .describe("Filter by namespace (omit for all)"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ namespace }) => {
        const nsFlag = namespace ? `-n ${namespace}` : "--all-namespaces";
        const result = await runOnNode(K3S_NODE, `sudo ${KUBECONFIG} helm list ${nsFlag} -o table 2>&1`);
        return {
            content: [
                {
                    type: "text",
                    text: `## Helm Releases\n\`\`\`\n${result.stdout || result.stderr}\n\`\`\``,
                },
            ],
        };
    });
    // ── helm_status ──────────────────────────────────────────────────────────
    server.registerTool("helm_status", {
        title: "Helm Release Status",
        description: "Get detailed status of a specific Helm release including deployed resources.",
        inputSchema: z.object({
            release: z.string().describe("Helm release name"),
            namespace: z.string().describe("Namespace of the release"),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ release, namespace }) => {
        const result = await runOnNode(K3S_NODE, `sudo ${KUBECONFIG} helm status ${release} -n ${namespace} 2>&1 && \
         sudo ${KUBECONFIG} helm get values ${release} -n ${namespace} 2>&1`);
        return {
            content: [
                {
                    type: "text",
                    text: `## Helm Status: ${release}\n\`\`\`\n${result.stdout || result.stderr}\n\`\`\``,
                },
            ],
        };
    });
    // ── helm_uninstall ───────────────────────────────────────────────────────
    server.registerTool("helm_uninstall", {
        title: "Helm Uninstall Release",
        description: "Uninstall a Helm release from the k3s cluster.",
        inputSchema: z.object({
            release: z.string().describe("Helm release name to uninstall"),
            namespace: z.string().describe("Namespace of the release"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ release, namespace }) => {
        const result = await runOnNode(K3S_NODE, `sudo ${KUBECONFIG} helm uninstall ${release} -n ${namespace} 2>&1`);
        const status = result.code === 0 ? "UNINSTALLED" : "FAILED";
        return {
            content: [
                {
                    type: "text",
                    text: `## Helm Uninstall: ${release}\n**Status:** ${status}\n\`\`\`\n${result.stdout || result.stderr}\n\`\`\``,
                },
            ],
        };
    });
}
//# sourceMappingURL=helm.js.map