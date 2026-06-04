---
id: PIPE-40.4
title: Implement XState inspection to runtime observability bridge
status: Done
assignee: []
created_date: '2026-06-03 09:25'
updated_date: '2026-06-04 09:21'
labels:
  - xstate
  - observability
  - runtime
dependencies:
  - PIPE-40.2
references:
  - src/pipeline-runtime.ts
documentation:
  - 'https://stately.ai/docs/inspection'
  - 'https://stately.ai/docs/system'
modified_files:
  - src/runtime-observability-inspection.ts
  - tests/runtime-observability-inspection.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 77000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the bridge that consumes XState v5 inspection events and emits stable runtime observability events. This gives actor-level diagnostics without exposing raw XState inspection as the public contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Bridge accepts XState inspection events for @xstate.actor, @xstate.event, @xstate.snapshot, and @xstate.microstep.
- [x] #2 Bridge maps actor lifecycle, event communication, snapshots, and microsteps into stable domain observability events defined in PIPE-40.2.
- [x] #3 Bridge preserves actor IDs/system IDs so diagnostics can identify pipeline, workflow, node, gate, and hook actors.
- [x] #4 Bridge supports filtering or redaction so large node outputs and hook outputs are not emitted through raw snapshot payloads by default.
- [x] #5 Unit tests cover actor creation, event communication, snapshot update, microstep transition, and output redaction.
- [x] #6 No changes are made to runner-event-sink or pipeline-runtime.ts in this ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/runtime-observability-inspection.ts and tests/runtime-observability-inspection.test.ts. Keep public PipelineRuntimeEvent mapping for a later ticket.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented the XState inspection to runtime observability bridge with actor/event/snapshot/microstep mapping and redaction behavior. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.
<!-- SECTION:FINAL_SUMMARY:END -->
