---
name: manifest-deploy
description: >
  Deploy one or more Kubernetes manifests to the cluster with full pre-flight validation.
  Checks ARM64 images, resource limits, node selectors, storage class, secret existence,
  and Pi hardware constraints before applying. Rolls back on failure.
  Use instead of bare `kubectl apply` for any production manifest change.
argument-hint: "<manifest-path> [namespace] [--dry-run]"
allowed-tools: >
  mcp__cloudless-infra__cluster_run_command,
  mcp__cloudless-infra__k3s_get_pods,
  mcp__cloudless-infra__k3s_get_pod_logs,
  mcp__cloudless-infra__k3s_restart_deployment,
  mcp__Kubernetes_MCP_Server__kubectl_get,
  mcp__Kubernetes_MCP_Server__kubectl_describe,
  mcp__Kubernetes_MCP_Server__kubectl_apply,
  mcp__Kubernetes_MCP_Server__kubectl_rollout,
  Bash,
  Read
---

# Manifest Deploy Skill

Safe deploy agent that validates manifests against this cluster's Pi hardware constraints
before applying them. Always performs a dry-run first.

## Step 0 — Parse arguments

- `$ARGUMENTS` must contain a manifest path (relative to repo root)
- Optional: namespace override (uses manifest's namespace if omitted)
- `--dry-run` flag: runs all checks and server-side dry-run, but does NOT apply

## Step 1 — Read the manifest

Read the manifest file. Extract:
- All container images (`spec.containers[*].image`, `spec.initContainers[*].image`)
- All `resources.requests` and `resources.limits` blocks
- `nodeSelector` fields
- `storageClassName` from any PVCs or volumeClaimTemplates
- `secretRef` / `secretKeyRef` / `existingSecret` references
- `tolerations`

## Step 2 — Pre-flight checks

Run all checks. Collect all failures before stopping (don't abort on first failure).

### 2A. ARM64 image check

For each unique image that is not `busybox`, `alpine`, or a k8s.io/* system image:

```bash
docker manifest inspect <image> 2>/dev/null \
  | jq '.manifests[]?.platform | select(.os=="linux" and .architecture=="arm64") | "arm64 ok"'
```

If `docker` is not available locally, check Docker Hub or use `skopeo`:
```bash
skopeo inspect --raw docker://<image> \
  | jq '.manifests[]?.platform | select(.architecture=="arm64")'
```

FAIL if: image has no `linux/arm64` manifest.
WARN if: image tag is `latest` (mutable, non-reproducible).

### 2B. Resource limits check

FAIL if any container is missing `resources.limits.memory`.
FAIL if any container is missing `resources.requests.memory`.
WARN if `limits.cpu` is missing (throttling can occur on omv's 4 cores).

Validate limits are sane for Pi hardware:
- WARN if any single container requests >2000m CPU (Pi 5 has 4 cores — 2 cores is a heavy load)
- WARN if any single container requests >1500Mi memory on omv
- FAIL if any single container requests >600Mi memory on omv-ha (tainted, but guard anyway)

### 2C. Node selector check

If the manifest schedules user pods (Deployment, StatefulSet, DaemonSet, Job, CronJob):
- FAIL if `nodeSelector: kubernetes.io/hostname: omv-ha` is set on a non-maintenance workload
- WARN if no `nodeSelector` is set (pods will land wherever scheduler decides — on a 2-node cluster that may be omv-ha)
- PASS if `nodeSelector: kubernetes.io/hostname: omv`

Exception: DaemonSets are exempt from nodeSelector check.
Exception: Jobs/CronJobs with `hostPID: true` are exempt if they have the control-plane toleration.

### 2D. Storage class check

For each PVC or volumeClaimTemplate:
- `storageClassName: local-path` → verify the consuming pod has `nodeSelector: kubernetes.io/hostname: omv` (local-path volumes can only mount on the node where they were provisioned)
- `storageClassName: nfs` → no node selector constraint, both nodes can mount
- Missing `storageClassName` → WARN (uses cluster default, which may be local-path)

### 2E. Secret existence check

For each `secretRef`, `secretKeyRef`, or `existingSecret` reference, verify the secret exists:

```bash
kubectl get secret <secret-name> -n <namespace> --no-headers 2>&1
```

FAIL if any referenced secret does not exist. Print the exact command to create it.

### 2F. Namespace existence check

```bash
kubectl get namespace <namespace> --no-headers 2>&1
```

FAIL if namespace does not exist. Print: `kubectl create namespace <namespace>`.

## Step 3 — Server-side dry run

If pre-flight passes (no FAILs):

```bash
kubectl apply --dry-run=server -f <manifest-path>
```

FAIL if server dry-run returns any error.
WARN on `configured` vs `created` (update vs create).

If `--dry-run` flag was passed, **stop here** and report results.

## Step 4 — Apply

```bash
kubectl apply -f <manifest-path>
```

## Step 5 — Post-apply verification

Wait up to 90 seconds for pods to reach Running state.

```bash
# Get pods from the manifest's namespace
kubectl get pods -n <namespace> -l <selector-from-manifest> -o wide --watch &
sleep 90
kill %1
kubectl get pods -n <namespace> -l <selector-from-manifest> -o wide
```

For Deployments/StatefulSets, verify rollout:
```bash
kubectl rollout status deployment/<name> -n <namespace> --timeout=90s
```

**Success conditions:**
- All pods `Running` with `READY` matching expected replicas
- No pods in `CrashLoopBackOff`, `OOMKilled`, `Error`, `Pending`
- No `ImagePullBackOff` (would have been caught in 2A but verify)

**On failure:** capture pod describe and logs, then roll back:
```bash
kubectl rollout undo deployment/<name> -n <namespace>
```

## Report format

```
MANIFEST DEPLOY: PASSED / FAILED / DRY-RUN ONLY

Pre-flight:
  ARM64 images        ✅/❌  [images checked | failed images]
  Resource limits     ✅/⚠️  [all set | warnings]
  Node selector       ✅/⚠️  [omv pinned | none set]
  Storage class       ✅/⚠️  [local-path+nodesel | nfs | warnings]
  Secrets exist       ✅/❌  [all present | missing: <names>]
  Namespace exists    ✅/❌

Server dry-run:       ✅/❌
Apply result:         created/configured/unchanged

Post-apply:
  Pods ready:         ✅/❌  [N/N running | failures]
  Rollout status:     ✅/❌

Actions taken:
  - [step] → [result]

Remaining manual actions (if any):
  - [description]
```
