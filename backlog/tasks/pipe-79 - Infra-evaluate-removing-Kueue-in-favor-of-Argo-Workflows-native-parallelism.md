---
id: PIPE-79
title: 'Infra: evaluate removing Kueue in favor of Argo Workflows native parallelism'
status: To Do
assignee: []
created_date: '2026-06-12 20:11'
updated_date: '2026-06-12 20:16'
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
- [ ] #1 Written evaluation: what Kueue provides today vs Argo-native equivalents, with a keep/remove decision
- [ ] #2 If remove: Kueue controller, labels, manifests, moka-submit injection, and console queue columns are gone and a real workflow still runs end-to-end
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
