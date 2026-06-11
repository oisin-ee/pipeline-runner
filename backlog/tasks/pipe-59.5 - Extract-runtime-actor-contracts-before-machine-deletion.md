---
id: PIPE-59.5
title: Extract runtime actor contracts before machine deletion
status: To Do
assignee: []
created_date: '2026-06-11 21:15'
labels:
  - refactor
  - runtime
  - contracts
dependencies:
  - PIPE-57
  - PIPE-58
parent_task_id: PIPE-59
priority: high
ordinal: 202000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
First dependency of the de-xstate phase. `src/runtime-machines/contracts.ts` currently mixes pure public runtime contract pieces with machine-specific event/state declarations. Before any machine file is deleted, move the public pieces into a non-machine module so Pipeline Console event records and runtime imports survive unchanged. This ticket must not change runtime behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new non-machine module owns `runtimeActorId`, `RuntimeActorIdParts`, `RuntimeActorKind`, `RuntimeActorDescriptor`, `RuntimeObservabilityEmitter`, `RuntimeObservabilityEvent`, `RetryReason`, and `NodeRetryPolicyContract`.
- [ ] #2 All non-machine importers use the new module path: `src/pipeline-runtime.ts`, `src/runtime/events/events.ts`, `src/runtime-observability.ts`, `src/runtime-observability-inspection.ts`, `src/runtime/gates/gates.ts`, `src/runtime/hooks/hooks.ts`, and `src/runtime/contracts/contracts.ts`.
- [ ] #3 `runtimeActorId` output is byte-identical for workflow, node, gate, and hook actors; PIPE-57 actor-id goldens pass unchanged.
- [ ] #4 `src/runtime-machines/contracts.ts` contains only machine-specific declarations after the move, or is left as a temporary re-export shim that is explicitly deleted by PIPE-59.4.
- [ ] #5 No public export path from `package.json` changes in this ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create a small deep module, for example `src/runtime/actor-ids.ts` or `src/runtime/runtime-actors.ts`, and move only contract-level actor/id/observability/retry types into it. Update import paths mechanically. Keep the old machine-specific event/state-name arrays in `src/runtime-machines/contracts.ts` until the machine deletion tickets remove them. Run the PIPE-57 actor-id tests, focused runtime observability tests, and typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
This is a shared-contract ticket. It exists to prevent PIPE-59.1 through PIPE-59.4 from deleting public event-contract utilities while removing machines. Do not rename `pipeline.workflow`, `pipeline.node`, `pipeline.gate`, `pipeline.hook`, or the dot-separated part order. Do not introduce a compatibility shim unless it is explicitly temporary and deleted by PIPE-59.4.
<!-- SECTION:NOTES:END -->
