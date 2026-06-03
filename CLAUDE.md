# omv-ha cluster — Claude memory

## After any infrastructure change or hardening PR
Log a Notion task in the **Tasks** database (`Themis128/Cloudless` workspace) with:
- Type: Chore
- Labels: docs
- Due Date: ~1 year out
- Content: what was changed, what to verify annually, relevant PR link

## omv-ha node (Pi 4, 1 GB) — annual config checklist
See Notion task "Annual omv-ha node config review" (due 2027-06-01) for the full checklist.
Key invariants to maintain:
- `node-taint: control-plane:NoSchedule` must remain in `/etc/rancher/k3s/config.yaml`
- systemd memory ceiling must be applied: `MemoryHigh=750M` / `MemoryMax=900M` (script: `k8s/ha/scripts/apply-omv-ha-memory-ceiling.sh`)
- `kube-reserved=memory=300Mi` — do NOT reduce; etcd+apiserver+controllers need it
- `ntfy` and Alertmanager must run on `omv`, not omv-ha
- `journal-vacuum-omv-ha` CronJob must keep its `control-plane:NoSchedule` toleration
