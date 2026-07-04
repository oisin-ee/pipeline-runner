---
id: PIPE-54.7
title: Verify Moka submits real Argo Workflows
status: To Do
assignee: []
created_date: '2026-06-10 14:10'
updated_date: '2026-07-04 19:54'
labels:
  - momokaya
  - verification
  - argo
dependencies:
  - PIPE-54.5
  - PIPE-54.6
  - PIPE-54.8
references:
  - tests/cli.test.ts
  - tests/argo-submit.test.ts
  - tests/argo-workflow.test.ts
  - Dockerfile
parent_task_id: PIPE-54
priority: high
ordinal: 171000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prove the Moka command shape through real repository usage and real Argo Workflow submission, not only isolated unit tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `npm run check`, `npm run typecheck`, `npm test`, and `npm run build` pass
- [ ] #2 `fallow audit --gate new-only --include-entry-exports` reports zero introduced dead code, complexity, and duplication
- [ ] #3 Built CLI help shows `moka submit` and does not show old user-facing quick/execute/argo submit-command routes
- [ ] #4 A disposable local Kubernetes cluster with Argo installed accepts `moka submit "build the feature"` and produces a Workflow DAG
- [ ] #5 The same cluster accepts `moka submit --quick "fix this"` and produces a Workflow DAG
- [ ] #6 The same cluster accepts `moka submit --command -- codex -p "fix"` and produces a one-task Workflow DAG with runner-command args
- [ ] #7 Cluster inspection confirms no Kubernetes Job resources are created by these paths
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the repository verification standard. Build the package, run the installed/built CLI, create a disposable k3d or equivalent local cluster, install Argo Workflows, submit full/quick/command paths with real manifests, inspect Workflow specs, and delete the cluster. Do not publish locally.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Groomed 2026-07-04. VERDICT: GROOM — keep To Do (blocker resolved, but no fresh disposable-cluster evidence recorded, and ACs partly stale vs current architecture).

BLOCKER RESOLVED: the Final Summary below ('proper graph lowering remains required', 'fake builtin/group/parallel lowering removed') is now STALE. Graph-to-Argo lowering landed in PIPE-54.8 (commit f53d083 'feat: complete graph-to-Argo lowering semantics'). src/argo-graph.ts now lowers builtin/group/parallel node kinds (cases at argo-graph.ts:116/120/127; exhaustive `never` guard + validation error at :49 for genuinely unsupported kinds). All 54.7 dependencies (54.5/54.6/54.8) are Done and the parent epic PIPE-54 is marked Done (2026-07-04).

ARCHITECTURE DRIFT in the ACs: per PIPE-54/54.8 the current model submits generated graphs as DYNAMIC DB-drained Argo Workflows created IN THE RUNNER POD, not a statically client-compiled DAG. So AC#4/#5 'produces a Workflow DAG' should be reframed to 'produces a root Argo Workflow that drains its schedule from the durable store' (workflowId schedule-run-<id>-root).

WHY STILL OPEN: this is a real-cluster verification ticket (disposable k3d/k8s + Argo, submit full/quick/command, inspect Workflow specs, confirm zero k8s Jobs). PIPE-54's closure cites unit-test evidence (moka-submit/argo-submit/argo-workflow tests), not a live disposable-cluster run of all three paths post-54.8. Real submit→Argo cluster evidence does exist in adjacent dogfoods (PIPE-94.9 submit→kill→inspect→resume end-to-end, Done). DECISION FOR USER: either (a) run the disposable-cluster verification against the current dynamic-DB-drained paths and close, or (b) fold this into PIPE-94.9's dogfood evidence and archive as superseded. Not closing unilaterally — no fresh evidence read for this ticket's specific ACs.

Archived 2026-07-04 as SUPERSEDED (Oisin decision). The technical blocker (client-side graph lowering) was resolved by PIPE-54.8 / commit f53d083 (src/argo-graph.ts lowers builtin/group/parallel); parent epic PIPE-54 is Done. This ticket's ACs assume a client-compiled DAG, but the architecture is now dynamic DB-drained in-runner (PIPE-91/94 durable substrate). Real moka→Argo submit is proven by PIPE-94 (SHIPPED) and covered going forward by the PIPE-94.9 dogfood. No separate client-DAG verification is meaningful under the new model.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Not complete. Command-mode submission was accepted by a disposable Argo cluster, but full/quick generated graph submissions exposed unsupported non-command node kinds. The fake builtin/group/parallel lowering was removed; proper graph lowering remains required.
<!-- SECTION:FINAL_SUMMARY:END -->
