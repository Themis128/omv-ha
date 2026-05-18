---
name: runner-ops
description: Health-check and fix the GitHub Actions self-hosted runner fleet — runner status, queue backlog, zombie runners, billing lock, and label routing. Use when CI is queued/stuck, a runner is offline, deploys land on the wrong runner, or after adding/removing a runner.
argument-hint: "[check | fix | legion] — default check"
allowed-tools: mcp__cloudless-infra__gh_runner_health, mcp__cloudless-infra__gh_runner_list, mcp__cloudless-infra__gh_runner_set_labels, mcp__cloudless-infra__gh_runner_register, mcp__cloudless-infra__gh_workflow_list, mcp__cloudless-infra__cluster_run_command, Bash, Read
---

Check-and-fix agent for the GitHub Actions self-hosted runner fleet that serves
`cloudless.gr` and `cloudless-manager`.

## Step 0 — Argument routing

- empty or `check` → run Steps 1–3 (read-only audit), report, stop
- `fix` → run Steps 1–3, then apply the safe auto-fixes in Step 4
- `legion` → skip the audit, print the Legion supplementary-runner registration steps

---

## Runner topology

**Pi fleet** — all three run on `omv-main` (Pi 5, 192.168.1.128), arm64, registered to `Themis128/cloudless.gr`:

| Runner | Service dir on omv-main | Labels |
|--------|-------------------------|--------|
| `omv`   | `~/actions-runner-cloudless`   | `self-hosted, Linux, ARM64, omv, pi` |
| `omv-2` | `~/actions-runner-cloudless-2` | `self-hosted, Linux, ARM64, omv, pi` |
| `omv-3` | `~/actions-runner-cloudless-3` | `self-hosted, Linux, ARM64, omv, pi` |

**cloudless-manager** has one runner — `omv-main` in `~/actions-runner` — serving `Themis128/cloudless-manager`.

**Legion (optional supplement)** — a runner inside WSL2 Ubuntu on the Legion laptop, x64,
label `omv` **only** (no `pi`). Interim CI capacity while GitHub-hosted runners are
billing-locked. Not always-on — treat as a bonus, never a dependency.

## Label routing — why the `pi` label exists

`runs-on` matches by **AND**: a job runs on a runner only if the runner carries
*every* label in the job's `runs-on` array.

| Workflow class | `runs-on` | Eligible runners |
|----------------|-----------|------------------|
| CI / audits (ci, codeql, a11y, …) | `[self-hosted, omv]` | any `omv` runner — Pi **or** Legion |
| Cluster-bound (`deploy-pi.yml`, `build-pi-image.yml`) | `[self-hosted, omv, pi]` | Pi runners **only** |

`deploy-pi.yml` runs `kubectl`/`sudo ctr` against the local k3s API and `build-pi-image.yml`
builds native arm64 — both would fail on a non-Pi runner. The `pi` label keeps them
Pi-exclusive. **Never add the `pi` label to a non-Pi runner.**

---

## Step 1 — Fleet health

Run `gh_runner_health(repo="cloudless.gr")`. If the user mentioned cloudless-manager,
also run it for that repo. The tool reports each runner, queue depth, and a
HEALTHY / DEGRADED / CRITICAL verdict, and flags zombie + billing-lock conditions.

## Step 2 — Interpret

| Symptom | Meaning | Goes to |
|---------|---------|---------|
| Runner `offline` | service down / host asleep / network | Fix 4A |
| Runner `busy` but **0 jobs in_progress** while work is queued | **zombie** — runner stuck | Fix 4B |
| Recent jobs fail in <15s with no steps | **billing lock** | Fix 4C — *not* auto-fixable |
| `queued` ≫ online runners | genuine backlog | Fix 4D |
| Cluster workflow stuck `queued` forever | no runner matches `[self-hosted, omv, pi]` | Fix 4E |

## Step 3 — Queue detail (if backlog or stuck runs)

`gh_workflow_list(repo, limit=30)` — identify which branches/workflows fill the queue.
A run stuck `queued` with no eligible runner never starts on its own.

---

## Step 4 — Fix playbook

### 4A. Offline runner

First check the service on omv-main (substitute the dir from the topology table):
```
cluster_run_command(node="omv-main", command=
  "systemctl --type=service | grep actions.runner || true; \
   ps aux | grep -E 'Runner.Listener' | grep -v grep")
```
- Service inactive → `cluster_run_command(node="omv-main", command="cd ~/actions-runner-cloudless-2 && sudo ./svc.sh start")`
- Service active but still offline on GitHub → re-register (Fix 4B).
- Legion runner offline → the laptop is asleep/off or WSL2 stopped. Expected; not a fault.

### 4B. Zombie runner (busy, but nothing in_progress)

A simple `systemctl restart` is **not enough** — it reconnects but keeps hitting
`A session for this runner already exists`. Do the full re-registration cycle on
omv-main (example for `omv-2`, dir `~/actions-runner-cloudless-2`):

```
cluster_run_command(node="omv-main", command="
  cd ~/actions-runner-cloudless-2
  sudo ./svc.sh stop || true
  sudo ./svc.sh uninstall || true
  TOKEN=$(cd ~ && echo)   # placeholder — see note
")
```
Registration/removal tokens are short-lived and minted from a Windows shell, not
the Pi. From the workstation:
```
gh api -X POST repos/Themis128/cloudless.gr/actions/runners/remove-token   --jq .token
gh api -X POST repos/Themis128/cloudless.gr/actions/runners/registration-token --jq .token
```
Then on omv-main, inside the runner dir:
```
./config.sh remove --token <REMOVE_TOKEN>
./config.sh --url https://github.com/Themis128/cloudless.gr --token <REG_TOKEN> \
  --name omv-2 --labels omv,pi --unattended --replace
sudo ./svc.sh install tbaltzakis
sudo ./svc.sh start
```
Re-verify with `gh_runner_health`. `self-hosted`, `Linux`, `ARM64` are auto-added —
only pass `omv,pi` to `--labels`.

### 4C. Billing lock — NOT auto-fixable

Jobs failing in seconds with no steps and the annotation
*"account is locked due to a billing issue"* mean GitHub-hosted runners are disabled
**account-wide** (public repos included). Self-hosted runners keep working.

This requires a payment/account action — **only the account owner** can resolve it at
`github.com/settings/billing`. Do **not** attempt to fix it from here. Report it,
state that CI must stay on self-hosted until it clears, and stop.

### 4D. Backlog (queue deep, no stuck runners)

Not a fault — throughput. `cloudless.gr` is a **private** repo, so GitHub-hosted
runners are **not free** — they bill against the plan, and since 2026-03-01 even
self-hosted minutes bill on private repos. Self-hosted is the cost-right home for
this repo's CI; the goal is to drain the queue, not move off self-hosted. Levers:
1. Confirm `cancel-in-progress` concurrency is on the audit workflows (cuts redundant runs).
2. Tighten path filters so a PR only triggers the audits relevant to its diff.
3. Add the Legion supplementary self-hosted runner — run this skill with `legion`.

Moving CI to GitHub-hosted `ubuntu-latest` is a **paid** choice on a private repo,
not a free fix — never recommend it as "the permanent fix". (It was tried in
PR #166 and reverted in #171 for exactly this reason.)

Do **not** mass-cancel other branches' queued runs to "drain faster" — that strands
those PRs. Only cancel runs the user explicitly identifies as stale.

### 4E. Label drift / cluster job stuck queued

If `deploy-pi.yml` or `build-pi-image.yml` hangs `queued`, a Pi runner is missing the
`pi` label. Re-apply it:
```
gh_runner_set_labels(repo="cloudless.gr", runner="omv-2", labels=["pi"], mode="add")
```
If a non-Pi runner wrongly has `pi`, re-register it (4B) with `--labels omv` only —
labels can be added via API but the safe way to *remove* one is re-registration.

---

## Step 5 — `legion` argument: register the supplementary runner

Print these steps for the user to run in a **WSL2 Ubuntu** terminal (never native
Windows — the workflows are bash). Mint a fresh token first from the workstation:
`gh api -X POST repos/Themis128/cloudless.gr/actions/runners/registration-token --jq .token`
(valid ~1 hour).

```bash
mkdir -p ~/actions-runner-cloudless && cd ~/actions-runner-cloudless
curl -o actions-runner.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.334.0/actions-runner-linux-x64-2.334.0.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/Themis128/cloudless.gr --token <REG_TOKEN> \
  --name legion --labels omv --unattended --replace
sudo ./bin/installdependencies.sh        # once, for .NET + Playwright apt deps
sudo ./svc.sh install && sudo ./svc.sh start
```
`--labels omv` (no `pi`) is mandatory — it keeps `deploy-pi`/`build-pi-image` off the
laptop. To retire it later: `sudo ./svc.sh stop && sudo ./svc.sh uninstall` then
`./config.sh remove --token <REMOVE_TOKEN>`.

---

## Reference — runner billing (as of 2026-03)

- **Public repo, self-hosted** → free.
- **Private repo, self-hosted** → billed `$0.002/min` since 2026-03-01, counts against
  plan minutes. A private repo's self-hosted usage can therefore trigger an account
  billing lock.
- **GitHub-hosted runners** → billed; free tier on public repos only.
- A billing lock disables **all** GitHub-hosted runners account-wide; self-hosted
  continue to run.
- **This project's repos:** `cloudless.gr` and `omv-ha` are **PRIVATE**;
  `cloudless-manager` is **public**. cloudless.gr CI therefore belongs on the
  self-hosted Pi runners — GitHub-hosted `ubuntu-latest` would bill every job.

## Report format

```
RUNNER FLEET: HEALTHY / DEGRADED / CRITICAL — <repo>

Runners:
  omv    🟢 idle  — self-hosted,Linux,ARM64,omv,pi
  omv-2  🟢 busy  — self-hosted,Linux,ARM64,omv,pi
  omv-3  🔴 offline

Queue: X queued · Y in-progress · Z online runners

Issues:
  - <symptom> → <fix applied / manual action needed>

Actions taken:
  - <fix> → <result>
```

Flag CRITICAL if: billing lock, or all runners offline.
Flag DEGRADED if: a zombie runner, one runner offline, or a deep backlog.

## Known non-issues (do not flag)

- Legion runner `offline` → laptop asleep/off; jobs reroute to the Pi. Expected.
- `s3-to-duckdb-sync` / ML CronJob pods Completed → unrelated to runners.
- A workflow `queued` for a minute or two under normal load → just wait.
- Multiple Pi runners `busy` *with* a matching count of in_progress jobs → healthy.
