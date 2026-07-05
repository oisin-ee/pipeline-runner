---
id: PIPE-52.3
title: Define persistent pipeline goal-state contract
status: Done
assignee: []
created_date: "2026-06-08 19:00"
updated_date: "2026-06-08 19:41"
labels:
  - goal-loop
  - runtime-contract
dependencies:
  - PIPE-52.1
references:
  - src/runtime/events/events.ts
  - src/pipeline-runtime.ts
  - src/runtime-machines/workflow-machine.ts
modified_files:
  - src/runtime/goal-state/goal-state.ts
  - src/runtime/goal-state/goal-state.test.ts
  - src/runtime/goal-state/index.ts
parent_task_id: PIPE-52
priority: high
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add a typed, persisted run-level goal state contract that captures original task, task refs, schedule id/path, node/gate attempts, verifier/acceptance evidence, continuation history, blocked reasons, and terminal outcome.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 A Zod schema and TypeScript type define the persisted goal state and reject malformed state.
- [ ] #2 State records gate failures, verifier verdicts, acceptance criteria verdicts, changed files, and continuation attempts without storing unbounded runner output.
- [ ] #3 Unit tests cover initial state, update from node/gate events, verifier failure, acceptance failure, pass, blocked, cancelled, and corrupt-state handling.
- [ ] #4 Goal state can be reconstructed from runtime events or loaded from the run artifact goal-state.json under the matching pipeline run directory.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Implement a small runtime goal-state module rather than spreading state writes through node execution. Use existing event and schema patterns, Zod for validation, and JSON file persistence under run artifacts. No new state-machine library is needed because runtime already uses XState.

<!-- SECTION:PLAN:END -->
