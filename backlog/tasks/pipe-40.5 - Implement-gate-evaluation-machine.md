---
id: PIPE-40.5
title: Implement gate evaluation machine
status: To Do
assignee: []
created_date: '2026-06-03 09:25'
labels:
  - xstate
  - runtime
  - gates
dependencies:
  - PIPE-40.2
references:
  - src/pipeline-runtime.ts
  - src/gates.ts
documentation:
  - 'https://stately.ai/docs/invoke'
modified_files:
  - src/runtime-machines/gate-machine.ts
  - tests/runtime-machines-gate.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 78000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build a standalone XState v5 gateEvaluationMachine for artifact, command, builtin, schema, semantic, acceptance, changed-file, and drain-merge gate phases. The machine is behavior-compatible with current gate results but gives each phase explicit observable state.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 gateEvaluationMachine is created with setup(...).createMachine(...) and typed context/events/actions/guards/actors.
- [ ] #2 The machine has explicit pending, running, passed, failed, timedOut, and cancelled states with gate/running/terminal/failure/cancelled tags.
- [ ] #3 Async gate implementations are invoked actors; async actions are not used for awaited gate work.
- [ ] #4 The machine emits stable gate observability events for gate.started, gate.finished, gate.failed, and gate.cancelled.
- [ ] #5 Unit tests cover at least one passing and one failing case for command, artifact, JSON schema, semantic verdict, acceptance coverage, changed-file policy, and builtin gate adapters.
- [ ] #6 No changes are made to evaluateNodeGates or pipeline-runtime.ts in this ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/runtime-machines/gate-machine.ts and tests/runtime-machines-gate.test.ts. Use adapter functions around existing gate implementations so the integration ticket can later swap callers without reimplementing gate logic.
<!-- SECTION:PLAN:END -->
