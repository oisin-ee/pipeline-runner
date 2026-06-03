---
id: PIPE-40.6
title: Implement node execution machine with explicit retry states
status: To Do
assignee: []
created_date: '2026-06-03 09:25'
labels:
  - xstate
  - runtime
  - node
dependencies:
  - PIPE-40.2
references:
  - src/pipeline-runtime.ts
documentation:
  - 'https://stately.ai/docs/setup'
  - 'https://stately.ai/docs/invoke'
modified_files:
  - src/runtime-machines/node-machine.ts
  - tests/runtime-machines-node.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 79000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the standalone XState v5 nodeExecutionMachine. It must model node lifecycle and retry policy explicitly, but must not yet integrate with pipeline-runtime.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 nodeExecutionMachine is created with setup(...).createMachine(...) and typed context/events/actions/guards/actors.
- [ ] #2 The machine exposes the explicit node states from PIPE-40.2 and uses tags for running, runner, gate, retrying, terminal, failure, and cancelled phases.
- [ ] #3 Retry is modeled with retrying state, attempt count in context, guard-based retry eligibility, and after-delay scheduling; it does not use p-retry.
- [ ] #4 Async work is represented by invoked actors for runner launch, changed-file snapshots, output recording, gate evaluation, and success/error hook requests; async actions are not used for awaited work.
- [ ] #5 Unit tests cover pass, runner nonzero failure, gate failure, timeout retry, retry exhaustion, cancellation, and skipped terminal state.
- [ ] #6 No changes are made to runPipelineFromConfig behavior in this ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/runtime-machines/node-machine.ts and tests/runtime-machines-node.test.ts. Use fake actor implementations in tests through machine.provide so behavior is deterministic.
<!-- SECTION:PLAN:END -->
