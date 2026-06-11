---
id: PIPE-59.1
title: Inline gate and hook machines into direct async evaluation
status: To Do
assignee: []
created_date: '2026-06-11 20:38'
updated_date: '2026-06-11 20:39'
labels:
  - refactor
  - runtime
dependencies: []
parent_task_id: PIPE-59
priority: high
ordinal: 188000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Step 1 of de-xstate. src/runtime-machines/gate-machine.ts (182 lines) and hook-machine.ts (219 lines) each wrap a single evaluate() promise with start/finish/cancelled observability emits and error-to-result conversion; src/runtime/gates/gates.ts and src/runtime/hooks/hooks.ts each do createActor -> send(START) -> waitFor(done) around one async call. Replace with a direct try/catch plus explicit observability emits in gates.ts and hooks.ts, preserving emitted event names (runtime.gate.started/finished/failed/cancelled and hook equivalents) and payload shapes exactly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 gate-machine.ts and hook-machine.ts are deleted; gates.ts and hooks.ts no longer import xstate.
- [ ] #2 Emitted observability event names and payloads are unchanged (PIPE-57 golden sequence passes).
- [ ] #3 Existing gate and hook behavioral test assertions are preserved against the new code.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
First executable change in the de-xstate sequence. Gate and hook evaluation is split: the machines wrap the promise and do try/catch + observability emit, while gates.ts and hooks.ts orchestrate the create/send/waitFor dance. Move both concerns into gates.ts/hooks.ts directly as try/catch blocks. The observability event names (runtime.gate.started, runtime.gate.failed, runtime.hook.cancelled, etc.) are part of the event record schema that Pipeline Console parses, so preserve them exactly. This is the lowest-risk step because gates and hooks are well-isolated and have focused tests.
<!-- SECTION:NOTES:END -->
