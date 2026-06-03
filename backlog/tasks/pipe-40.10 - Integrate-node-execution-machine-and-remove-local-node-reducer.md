---
id: PIPE-40.10
title: Integrate node execution machine and remove local node reducer
status: To Do
assignee: []
created_date: '2026-06-03 09:26'
updated_date: '2026-06-03 09:26'
labels:
  - xstate
  - runtime
  - node
  - integration
dependencies:
  - PIPE-40.6
  - PIPE-40.9
references:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
modified_files:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
  - package.json
  - bun.lock
parent_task_id: PIPE-40
priority: high
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make nodeExecutionMachine the source of truth for node lifecycle, retry, cancellation, and terminal node snapshots. Remove the local transitionNode/reduceNodeState model and p-retry-based node retry orchestration.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 executeNode or its replacement creates and runs a nodeExecutionMachine actor for each planned node.
- [ ] #2 NodeExecutionState values in PipelineRuntimeResult are derived from node actor snapshots, not manual transitionNode mutations.
- [ ] #3 p-retry is no longer used for node retry orchestration; retry delay, retry eligibility, retry exhaustion, and retry observability are owned by nodeExecutionMachine.
- [ ] #4 transitionNode, reduceNodeState, NodeStateEvent, NodeAttemptRetryError, and node p-retry plumbing are removed unless a remaining name is only a thin compatibility export with a documented deletion path in this same ticket.
- [ ] #5 Existing node behavior tests pass for success, nonzero failure, gate failure, retry_on, timeout, cancellation, fail-fast sibling skipping, changed-file policy, structured output repair, workflow child nodes, and parallel container children.
- [ ] #6 New tests assert explicit node state observability for runnerRunning, gatesRunning, retrying, passed, failed, cancelled, and skipped.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Modify src/pipeline-runtime.ts to replace node execution internals with nodeExecutionMachine actor execution. Keep workflow batch loops in place until PIPE-40.11. Remove p-retry dependency from package.json only if no other runtime path uses it; otherwise leave dependency cleanup to PIPE-40.12.
<!-- SECTION:PLAN:END -->
