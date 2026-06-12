---
id: PIPE-60.5
title: Extract NodeStateStore and trim RuntimeContext
status: Done
assignee: []
created_date: '2026-06-11 21:15'
updated_date: '2026-06-12 10:28'
labels:
  - refactor
  - runtime
dependencies:
  - PIPE-59.4
parent_task_id: PIPE-60
priority: medium
ordinal: 207000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trim RuntimeContext after xstate removal by grouping node execution state maps into a NodeStateStore. Today RuntimeContext carries several related mutable maps independently: nodeStates, nodeSnapshots, lastOutputByNode, inheritedOutputNodeIds, and structuredOutputs. Those fields are one concept: the runtime's per-node execution/output state. Extract that concept so callers do not pass a wide context object through unrelated code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A NodeStateStore owns nodeStates, nodeSnapshots, lastOutputByNode, inheritedOutputNodeIds, and structuredOutputs behind explicit methods or typed fields.
- [x] #2 RuntimeContext replaces those separate fields with one NodeStateStore field and drops any remaining xstate actor fields already made obsolete by PIPE-59.4.
- [x] #3 Scheduler/node/gate/hook code reads and writes node state through NodeStateStore without unsafe casts, non-null assertions, or broad optional fallbacks.
- [x] #4 Existing runtime behavior and PIPE-57 golden event/output contracts are unchanged.
- [x] #5 Focused runtime tests and typecheck pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create the store in the runtime contracts/state layer after PIPE-59.4 has removed xstate actor context. Migrate runtime call sites mechanically, then run the existing runtime tests. This ticket should not change Argo retryStrategy or lifecycle behavior; it is a context-shape cleanup that makes the one-engine runtime easier to pass around.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Avoid a shallow wrapper that only forwards arbitrary map access. The store should make the grouped concept clear and reduce RuntimeContext width without hiding important state transitions. If a caller needs many store internals, add a small domain method instead of exporting every map as mutable public surface.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
