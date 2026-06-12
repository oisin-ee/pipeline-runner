---
id: PIPE-59.3
title: >-
  Replace workflow-machine with plain ready-queue scheduler and shared lifecycle
  module
status: Done
assignee: []
created_date: '2026-06-11 20:38'
updated_date: '2026-06-12 10:28'
labels:
  - refactor
  - runtime
dependencies:
  - PIPE-59.2
parent_task_id: PIPE-59
priority: high
ordinal: 190000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Step 3 of de-xstate. src/runtime-machines/workflow-machine.ts (657 lines) injects every consequential behavior via input callbacks (runNode, runWorkflowHook, skipNode, shouldContinueAfterNodeResult); the machine itself is: run start hook -> loop { launch ready nodes up to capacity, await NODE_DONE, recompute ready set } -> success/failure hooks -> complete hook. Replace with src/runtime/scheduler.ts: a ready-queue loop reusing the already-pure functions at the bottom of workflow-machine.ts (readyNodeIds, workflowNodeCapacity, unstartedBlockingDescendants) plus Promise.race over in-flight node promises. Extract the workflow.start/success/failure/complete hook sequencing into src/runtime/workflow-lifecycle.ts so the Argo pipeline-finalizer can share it later (PIPE-60). Preserve: failFast forces serial execution AND skips unstarted nodes with the documented reason string; non-failFast blocks only unstarted descendants of the failed node; cancellation via the isCancelled callback at every decision point.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 workflow-machine.ts is deleted; src/runtime/scheduler.ts implements DAG execution as plain async code with no xstate.
- [x] #2 Lifecycle hook sequencing (start/success/failure/complete, incl. success-hook-failure handling) lives in src/runtime/workflow-lifecycle.ts.
- [x] #3 failFast serial execution, fail-fast skip reasons, descendant blocking, and cancellation semantics are unchanged (PIPE-57 tests pass).
- [x] #4 Concurrency cap honors maxParallelNodes exactly as before.
- [x] #5 readyNodeIds, workflowNodeCapacity, and unstartedBlockingDescendants are preserved as directly testable pure functions or equivalent exports.
- [x] #6 The lifecycle module has no Argo-specific imports; PIPE-60.2 owns adapting Argo to this shared module.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Move the pure scheduling helpers out of `src/runtime-machines/workflow-machine.ts`, then build `src/runtime/scheduler.ts` as a plain async ready-queue loop with Promise.race over in-flight node promises. Extract lifecycle hook sequencing into `src/runtime/workflow-lifecycle.ts` and call it from LocalScheduler only in this ticket. Rewrite workflow-machine tests against scheduler/lifecycle public behavior before deleting `workflow-machine.ts`. Run focused scheduler/lifecycle tests, pipeline-runtime integration tests, PIPE-57 goldens, and typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 3 of de-xstate: the scheduler loop. workflow-machine.ts (657 lines) is structurally: invoke start hook -> always block checking isCancelled, then { launch launchable nodes up to capacity via spawnChild, or check for completion, or run failure/success hooks } -> complete hook. Replace with src/runtime/scheduler.ts: plain async function with a while(running) loop, Promise.race over in-flight node promises, and readyNodeIds/workflowNodeCapacity as functions called directly. Extract the hook orchestration (start/success/failure/complete, incl. the success-hook-failure edge case where failure wins over success) into src/runtime/workflow-lifecycle.ts - this is used by BOTH the new local scheduler AND the Argo pipeline-finalizer in Phase 3 (PIPE-60). Preserve failFast serial execution, node-skip reasons for Argo logs, descendant-only blocking when non-failFast, and the isCancelled callback as a decision-point escape hatch.

Do not introduce a queue/concurrency library. The existing behavior is small enough that plain async plus the extracted pure helper functions is the clearest implementation and easiest contract to test.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
