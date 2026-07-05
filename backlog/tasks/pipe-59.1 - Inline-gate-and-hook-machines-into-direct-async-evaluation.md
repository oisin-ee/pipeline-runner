---
id: PIPE-59.1
title: Inline gate and hook machines into direct async evaluation
status: Done
assignee: []
created_date: "2026-06-11 20:38"
updated_date: "2026-06-12 10:28"
labels:
  - refactor
  - runtime
dependencies:
  - PIPE-59.5
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

- [x] #1 gate-machine.ts and hook-machine.ts are deleted; gates.ts and hooks.ts no longer import xstate.
- [x] #2 Emitted observability event names and payloads are unchanged (PIPE-57 golden sequence passes).
- [x] #3 Existing gate and hook behavioral test assertions are preserved against the new code.
- [x] #4 Cancellation/abort paths still emit the documented cancelled events and return the same runtime result shape.
- [x] #5 This ticket uses the runtime actor/observability contracts extracted by PIPE-59.5 and does not rename actor IDs or event payload fields.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Start from `src/runtime/gates/gates.ts` and `src/runtime/hooks/hooks.ts`. Inline the machine promise wrapper into direct async functions: emit started, await evaluator, emit finished/failed/cancelled, and convert thrown errors into the same result objects as today. Delete `src/runtime-machines/gate-machine.ts` and `src/runtime-machines/hook-machine.ts` only after their focused tests have been moved to the gate/hook modules. Run the focused gate/hook tests, PIPE-57 golden event checks, and typecheck.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

First executable change in the de-xstate sequence. Gate and hook evaluation is split: the machines wrap the promise and do try/catch + observability emit, while gates.ts and hooks.ts orchestrate the create/send/waitFor dance. Move both concerns into gates.ts/hooks.ts directly as try/catch blocks. The observability event names (runtime.gate.started, runtime.gate.failed, runtime.hook.cancelled, etc.) are part of the event record schema that Pipeline Console parses, so preserve them exactly. This is the lowest-risk step because gates and hooks are well-isolated and have focused tests.

Do not edit retry policy or workflow scheduling in this ticket. If a helper is needed, keep it local to gates/hooks unless the same helper is already provided by the contract module from PIPE-59.5.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.

<!-- SECTION:FINAL_SUMMARY:END -->
