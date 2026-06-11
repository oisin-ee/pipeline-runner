---
id: PIPE-60
title: Executor seam + Argo retryStrategy for infra flakes
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
labels:
  - refactor
  - runtime
  - argo
dependencies:
  - PIPE-59
priority: high
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3: formalize the execution substrate boundary and lean on Argo for infrastructure-level retries. After Phase 2, the node engine is unified. Now name the minimal scheduler abstraction: PipelineScheduler { runWorkflow(plan, ctx) -> Promise<PipelineRuntimeResult> }. LocalScheduler (from Phase 2) is the only in-process impl; Argo mode is documented as "compile plan -> submit Workflow CRD -> per-node runner-command executes via runScheduledWorkflowTask (same node engine)". The subtasks: (1) formalize the seam as an interface, (2) wire Argo finalizer to the shared workflow-lifecycle module (closes hook parity gap between local and remote), (3) add Argo retryStrategy retrying ONLY exit code 70 (infra flakes like pod crash, not task failures), (4) add parity contract test, (5) trim RuntimeContext from 22 to ~12 fields via NodeStateStore.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PipelineScheduler interface exists; LocalScheduler is the implementation.
- [ ] #2 Argo finalizer calls the shared workflow-lifecycle module; workflow.start/success/failure/complete hooks run the same in both execution paths.
- [ ] #3 Argo retryStrategy is configured to retry ONLY exit code 70 (infra startup failure) via expression; semantic retries stay in the node engine.
- [ ] #4 A parity contract test: same plan, stubbed node runner through LocalScheduler vs Argo DAG graph expansion -> equivalent execution order, skip reasons, and completion state.
- [ ] #5 RuntimeContext is reduced: nodeStates/nodeSnapshots/lastOutputByNode/inheritedOutputNodeIds/structuredOutputs grouped into NodeStateStore field.
<!-- AC:END -->
