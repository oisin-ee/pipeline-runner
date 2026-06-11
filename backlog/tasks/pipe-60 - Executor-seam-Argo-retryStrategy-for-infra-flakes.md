---
id: PIPE-60
title: Executor seam + Argo retryStrategy for infra flakes
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
updated_date: '2026-06-11 21:15'
labels:
  - refactor
  - runtime
  - argo
dependencies:
  - PIPE-59.4
priority: high
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3: formalize the execution substrate boundary and lean on Argo for infrastructure-level retries. After Phase 2, the node engine is unified. Now name the minimal scheduler abstraction: PipelineScheduler { runWorkflow(plan, ctx) -> Promise<PipelineRuntimeResult> }. LocalScheduler (from Phase 2) is the only in-process impl; Argo mode is documented as "compile plan -> submit Workflow CRD -> per-node runner-command executes via runScheduledWorkflowTask (same node engine)".

This parent tracks the Phase 3 outcome only. Implementation is split into spawnable children: PIPE-60.1 defines the scheduler seam, PIPE-60.2 wires Argo workflow lifecycle through the shared lifecycle module, PIPE-60.3 adds startup-only Argo retryStrategy for exit code 70, PIPE-60.4 adds the LocalScheduler-versus-Argo parity contract, and PIPE-60.5 trims RuntimeContext through NodeStateStore. Keep semantic retries in the runtime node engine; Argo retries are for infrastructure startup failures only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PIPE-60.1 defines the PipelineScheduler seam and LocalScheduler implementation boundary.
- [ ] #2 PIPE-60.2 makes workflow.start/success/failure/complete hook behavior shared between local and Argo paths.
- [ ] #3 PIPE-60.3 adds Argo retryStrategy for startup-only exit code 70 while leaving semantic retries in the node engine.
- [ ] #4 PIPE-60.4 proves LocalScheduler and Argo graph expansion preserve equivalent execution order, skip reasons, and completion state.
- [ ] #5 PIPE-60.5 groups runtime node execution maps into NodeStateStore and trims RuntimeContext.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Do not put the Argo retry or NodeStateStore work directly into the scheduler-seam ticket. The seam should make the boundary visible; the Argo lifecycle/retry/parity tickets then prove that the remote path is a thin frontend over the same node engine. The RuntimeContext cleanup is intentionally a sibling cleanup after xstate removal, not a prerequisite for Argo retryStrategy.
<!-- SECTION:NOTES:END -->
