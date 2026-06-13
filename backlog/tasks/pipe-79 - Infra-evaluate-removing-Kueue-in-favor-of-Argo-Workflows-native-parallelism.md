---
id: PIPE-79
title: 'Infra: evaluate removing Kueue in favor of Argo Workflows native parallelism'
status: Done
assignee: []
created_date: '2026-06-12 20:11'
updated_date: '2026-06-13 15:23'
labels:
  - 'repo:infra'
  - 'repo:pipeline'
  - 'repo:console'
  - phase-3
  - architecture
dependencies:
  - PIPE-81
references:
  - report/architecture-review-2026-06-12.md
priority: medium
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
For a single-user cluster, Kueue adds a controller, a label contract (kueue.x-k8s.io/queue-name on every Workflow), ServiceAccount plumbing, and console DB columns (k8s_queue_name, k8s_workload_name) — while Argo Workflows' own parallelism limits and semaphores likely cover the actual need (don't run too many agent jobs at once).

Evaluation task, not a foregone conclusion: enumerate what Kueue currently provides (admission/queueing/quota), map each to an Argo-native equivalent, and decide. If removal wins: strip the Kueue label injection from moka-submit, the workflow-controller default queue label, the kueue manifests, and the console's queue/workload tracking. If keep wins: write down the concrete future requirement that justifies it.

Spans infra + pipeline + console (label injection lives in moka-submit, tracking in console). Defer execution until after the Hatchet spike decision — a Hatchet go makes this moot.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Written evaluation: what Kueue provides today vs Argo-native equivalents, with a keep/remove decision
- [x] #2 If remove: Kueue controller, labels, manifests, moka-submit injection, and console queue columns are gone and a real workflow still runs end-to-end
- [ ] #3 If keep: the justifying requirement is documented in infra docs
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: evaluation task.
1. Inventory what Kueue provides today + map to Argo-native equivalents — model=sonnet, 2 parallel read-only agents (one over infra manifests, one over moka-submit/console code paths).
2. Keep/remove decision synthesis — model=opus, single short pass over the two inventories.
3. If remove: execution is mechanical deletion across 3 repos — model=sonnet, parallelizable per repo.
No Fable — the decision is binary and the evidence-gathering is mechanical.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
FULL REMOVAL executed across 3 repos + live cluster. Kueue is gone.

oisin-pipeline (934b0e9): queueName label injection + all schema/CLI/config/doctor plumbing removed; ~/.config/moka/config.yaml queueName line dropped; 564 tests green.
console (0b3a706,910a59f,2b971a6,9fa5942): kueue workload tracking removed from client/mappers/charts/tests; 'admitted' enum KEPT (only write path removed); RunnerWorkloadResource gone; forward migration server/drizzle/0010_remove_kueue_columns.sql (UNAPPLIED — applies on next console deploy). targeted tests green.
infra (dfe3435,cba813f,e4a29aa,3c5b90a): phased to avoid catastrophe — 3a moved pipeline-runner/moka-submitter SAs out of the kueue dir to a new pipeline-runner-rbac ArgoCD app; 3a.2 moved the momokaya-pipeline NAMESPACE ownership off kueue-topology (it was owned there — deleting kueue-topology would have pruned the whole namespace); 3b.1 deleted kueue-topology + manifests; 3b.2 deleted the controller app + argo-workflows queue label + observability ServiceMonitor/PrometheusRule + momokaya-agent RBAC + kueue topology doc + 2 e2e tests + the infra-036 build-entrypoint wait-kueue-admission steps (a live dependency the inventory MISSED). ArgoCD app deletion did NOT cascade-prune the orphaned controller, so manually cleaned: deleted both Fail-policy webhooks FIRST (else pod creation in momokaya-pipeline would be blocked), then CRs, then kueue-system namespace, then 11 CRDs + cluster RBAC.

Verification: during 3b.1 the namespace briefly went Terminating but pipeline-runner-rbac selfHeal recreated it + all 8 secrets/SAs within ~2min (everything GitOps-managed); final state: namespace Active, pipeline-runner+moka-submitter SAs present, argo-workflows + pipeline-runner-rbac Synced/Healthy, pod-creation smoke in momokaya-pipeline succeeds (no blocking webhook) = AC#2. Zero kueue CRDs/refs remain.

UNRELATED PRE-EXISTING: kube-prometheus-stack shows Degraded — the prometheus container is restarting (OOM-like) on a 5d-old pod; its config+rules load with zero errors and ArgoCD reports Synced, so NOT caused by this work. Flag for separate attention. FOLLOW-UPS: console deploy must run migration 0010; a future Argo-native runner-admission e2e could replace the deleted infra-040 disposable e2e; stale kueue mentions remain in a few infra docs (non-breaking).
<!-- SECTION:FINAL_SUMMARY:END -->
