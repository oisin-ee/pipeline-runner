---
id: PIPE-59.4
title: Rewire observability emits directly and drop the xstate dependency
status: To Do
assignee: []
created_date: '2026-06-11 20:38'
updated_date: '2026-06-11 20:39'
labels:
  - refactor
  - runtime
  - contracts
dependencies: []
parent_task_id: PIPE-59
priority: high
ordinal: 191000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Step 4 of de-xstate. src/runtime/runtime-observability-inspection.ts maps xstate @xstate.* inspection events to runtime.observability event records - the only genuine xstate facility in use, and it is an output contract, not a state-management need. Replace with direct emits from the new scheduler/tracker code. Move runtimeActorId and RuntimeActorDescriptor from src/runtime-machines/contracts.ts to src/runtime/actor-ids.ts - these leak into event records consumed by Pipeline Console, so the format must stay byte-identical. Then remove nodeActors/workflowActor from RuntimeContext (src/runtime/contracts/contracts.ts) and drop xstate from package.json.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 runtime-observability-inspection.ts is deleted; runtime.observability events are emitted directly with identical names and payloads.
- [ ] #2 runtimeActorId format is byte-identical (PIPE-57 golden event sequence passes).
- [ ] #3 xstate is removed from package.json; RuntimeContext no longer has nodeActors/workflowActor fields.
- [ ] #4 The runtime-machines test files are rewritten against the new modules, keeping their behavioral assertions.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 4 of de-xstate: drop the xstate dependency. runtime-observability-inspection.ts maps xstate @xstate.* inspection events to runtime.observability event records, which Pipeline Console consumes via the HTTP event sink. This is an output contract, not a state-management need - replace with direct emits from the scheduler/gate/hook/node-tracker code. Move runtimeActorId and RuntimeActorDescriptor from src/runtime-machines/contracts.ts to src/runtime/actor-ids.ts (these format strings are in the event schema, must stay byte-identical for the console to parse them). Remove nodeActors/workflowActor from RuntimeContext (src/runtime/contracts/contracts.ts) - they are now unused. Delete src/runtime-machines/ directory entirely and drop xstate from package.json. The runtime-machines test files get rewritten against the new modules, keeping their behavioral assertions as-is.
<!-- SECTION:NOTES:END -->
