---
id: PIPE-60.1
title: Define PipelineScheduler seam for local execution
status: To Do
assignee: []
created_date: '2026-06-11 21:15'
updated_date: '2026-06-11 21:15'
labels:
  - refactor
  - runtime
dependencies:
  - PIPE-59.4
parent_task_id: PIPE-60
priority: high
ordinal: 203000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define the execution-substrate boundary after PIPE-59 has removed xstate: a PipelineScheduler interface whose local implementation runs the already-unified node engine in process. The minimal shape is `runWorkflow(plan, ctx) -> Promise<PipelineRuntimeResult>`; keep the exact TypeScript names and generic shape aligned with existing runtime contracts rather than inventing a second result model.

This ticket does not implement Argo submission. It names the local scheduler seam and makes the remote path describable as "compile plan -> submit Workflow CRD -> each DAG task runs runScheduledWorkflowTask against the same node engine".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A PipelineScheduler interface exists in the runtime layer and returns the existing PipelineRuntimeResult shape.
- [ ] #2 The Phase 2 plain scheduler is exported as LocalScheduler through that interface with no xstate imports.
- [ ] #3 Existing runtime callers use the interface boundary where they schedule a workflow locally; node execution remains in the existing runScheduledWorkflowTask path.
- [ ] #4 No Argo CRD submission client, Kubernetes client, or new scheduler implementation is introduced in this ticket.
- [ ] #5 Typecheck and focused runtime tests pass through the public runtime entrypoints.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Touch the runtime contract and scheduler files created by PIPE-59.3/PIPE-59.4, plus the local runtime entrypoint that invokes the scheduler. Use existing TypeScript interfaces and Vitest tests; no new library is needed. Keep this as a naming/refactoring slice so PIPE-60.2/60.3/60.4 can depend on a stable boundary without also editing the same scheduler contract.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The point is architectural clarity, not another abstraction layer. The interface should be deep enough to describe the substrate switch and shallow enough that local execution still reads like direct async runtime code. Avoid optional parameters or partial-result shims that only exist to satisfy future Argo work.
<!-- SECTION:NOTES:END -->
