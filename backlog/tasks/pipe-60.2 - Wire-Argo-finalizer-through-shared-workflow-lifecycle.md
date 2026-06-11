---
id: PIPE-60.2
title: Wire Argo workflow lifecycle through shared lifecycle module
status: To Do
assignee: []
created_date: '2026-06-11 21:15'
updated_date: '2026-06-11 21:20'
labels:
  - refactor
  - argo
  - runtime
dependencies:
  - PIPE-60.1
parent_task_id: PIPE-60
priority: high
ordinal: 204000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Close the workflow-hook parity gap between local and Argo execution. PIPE-59.3 extracts workflow.start/success/failure/complete sequencing into `src/runtime/workflow-lifecycle.ts`; this ticket makes the Argo path use that same module instead of hand-rolled finalizer behavior. Argo cannot run every lifecycle phase only in the finalizer: workflow.start belongs before DAG task execution, while workflow.success, workflow.failure, and workflow.complete belong in the finalizer once node outcomes are known.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Argo workflow.start handling calls the shared workflow-lifecycle module before DAG node tasks are scheduled or executed.
- [ ] #2 Argo finalization calls the shared workflow-lifecycle module for workflow.success, workflow.failure, and workflow.complete.
- [ ] #3 Success-hook failure behavior matches the local lifecycle rule from PIPE-59.3: success-hook failure turns the workflow outcome into failure before complete runs.
- [ ] #4 Event records, hook payloads, and completion status are unchanged versus the pinned PIPE-57 golden contracts.
- [ ] #5 Focused Argo finalizer and runtime lifecycle tests cover success, node failure, success-hook failure, and cancellation/abort where the existing finalizer supports it.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update the Argo workflow generation/finalizer path and its tests. Reuse the shared lifecycle module from PIPE-59.3; do not duplicate hook ordering logic in Argo-specific files. If the Argo path needs a small adapter for finalizer inputs, keep it local to the Argo module and make it translate into the same lifecycle contract used by LocalScheduler.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The previous wording said "wire Argo finalizer" but full parity needs both start-time and finalizer-time integration. Keep that distinction explicit in the implementation and tests so future agents do not move workflow.start into a late finalizer phase.
<!-- SECTION:NOTES:END -->
