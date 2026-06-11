---
id: PIPE-59.4
title: Rewire observability emits directly and drop the xstate dependency
status: To Do
assignee: []
created_date: '2026-06-11 20:38'
updated_date: '2026-06-11 21:15'
labels:
  - refactor
  - runtime
  - contracts
dependencies:
  - PIPE-59.3
parent_task_id: PIPE-59
priority: high
ordinal: 191000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Step 4 of de-xstate. src/runtime/runtime-observability-inspection.ts maps xstate @xstate.* inspection events to runtime.observability event records - the only genuine xstate facility in use, and it is an output contract, not a state-management need. Replace with direct emits from the new scheduler/tracker/gate/hook code. Use the runtime actor contract module extracted by PIPE-59.5; if `src/runtime-machines/contracts.ts` was left as a temporary re-export shim, delete that shim here. Then remove nodeActors/workflowActor from RuntimeContext (src/runtime/contracts/contracts.ts) and drop xstate from package.json.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 runtime-observability-inspection.ts is deleted; runtime.observability events are emitted directly with identical names and payloads.
- [ ] #2 runtimeActorId format is byte-identical (PIPE-57 golden event sequence passes).
- [ ] #3 xstate is removed from package.json and the package manager lockfile; RuntimeContext no longer has nodeActors/workflowActor fields.
- [ ] #4 The runtime-machines test files are rewritten against the new modules, keeping their behavioral assertions.
- [ ] #5 All seven pre-refactor xstate import sites are gone: `src/pipeline-runtime.ts`, `src/runtime/gates/gates.ts`, `src/runtime/hooks/hooks.ts`, and the four files formerly under `src/runtime-machines/`.
- [ ] #6 No package public export path changes are introduced.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Replace the xstate inspection adapter with direct calls to the existing runtime observability emitter at the points where scheduler/tracker/gate/hook code already knows the event happened. Delete `src/runtime/runtime-observability-inspection.ts`, delete any remaining `src/runtime-machines` shim or machine files, remove xstate from package metadata, and update tests that previously asserted machine inspection behavior so they assert the same runtime.observability records from direct emits. Run PIPE-57 goldens, focused runtime observability tests, `bun run typecheck`, and the normal test/check suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 4 of de-xstate: drop the xstate dependency. runtime-observability-inspection.ts maps xstate @xstate.* inspection events to runtime.observability event records, which Pipeline Console consumes via the HTTP event sink. This is an output contract, not a state-management need - replace with direct emits from the scheduler/gate/hook/node-tracker code. runtimeActorId and RuntimeActorDescriptor were intentionally pulled out first by PIPE-59.5 because these format strings are in the event schema and must stay byte-identical for the console to parse them. Remove nodeActors/workflowActor from RuntimeContext (src/runtime/contracts/contracts.ts) - they are now unused. Delete src/runtime-machines/ entirely and drop xstate from package.json. The runtime-machines test files get rewritten against the new modules, keeping their behavioral assertions as-is.
<!-- SECTION:NOTES:END -->
