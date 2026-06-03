---
id: PIPE-40.7
title: Implement workflow scheduler machine
status: To Do
assignee: []
created_date: '2026-06-03 09:25'
labels:
  - xstate
  - runtime
  - workflow
dependencies:
  - PIPE-40.2
references:
  - src/workflow-planner.ts
  - src/pipeline-runtime.ts
documentation:
  - 'https://stately.ai/docs/actors'
  - 'https://stately.ai/docs/system'
modified_files:
  - src/runtime-machines/workflow-machine.ts
  - tests/runtime-machines-workflow.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build a standalone XState v5 workflowSchedulerMachine that models batch scheduling, max-parallel limits, fail-fast behavior, cancellation, drain behavior, and terminal workflow outcome without integrating it into pipeline-runtime.ts yet.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 workflowSchedulerMachine is created with setup(...).createMachine(...) and typed context/events/actions/guards/actors.
- [ ] #2 The machine explicitly represents planning, startingHooks, scheduling, runningBatch, failFastStopping, cancelling, completingHooks, passed, failed, and cancelled states.
- [ ] #3 The machine supports maxParallelNodes and failFast semantics without relying on ad hoc loops in tests.
- [ ] #4 The machine invokes child node actors through provided actor logic rather than importing node execution implementation directly.
- [ ] #5 Unit tests cover normal DAG execution, parallel batches, maxParallelNodes limiting, fail_fast stopping ready siblings, cancellation before scheduling dependents, and failure hook routing.
- [ ] #6 No changes are made to runPipelineFromConfig behavior in this ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/runtime-machines/workflow-machine.ts and tests/runtime-machines-workflow.test.ts. Use fake node actors and fake hook actors for deterministic scheduling tests.
<!-- SECTION:PLAN:END -->
