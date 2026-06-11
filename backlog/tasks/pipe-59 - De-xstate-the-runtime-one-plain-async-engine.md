---
id: PIPE-59
title: 'De-xstate the runtime: one plain-async engine'
status: To Do
assignee: []
created_date: '2026-06-11 20:38'
updated_date: '2026-06-11 20:39'
labels:
  - refactor
  - runtime
dependencies:
  - PIPE-57
  - PIPE-58
priority: high
ordinal: 187000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2, the keystone of the one-engine refactor. The four xstate machines in src/runtime-machines/ (~1,850 lines incl. glue) duplicate scheduling semantics that Argo already owns in production, and none of them uses xstate differentiators (serializable snapshots, resumption, inspection-for-users). Verified by reading: workflow-machine.ts (657 lines) is a ready-queue loop with four lifecycle hooks; node-machine.ts (344) is a passive status recorder whose retry decision functions are pure; gate-machine.ts (182) and hook-machine.ts (219) each wrap a single promise with try/catch plus observability emits. Replace them with plain async code reusing the already-pure helpers (readyNodeIds, workflowNodeCapacity, nodeRetryDecision, retryDelayMs). Outcome: roughly -1,850/+400 lines, xstate dependency removed, one mental model. Regression gate: tests/pipeline-runtime.test.ts passes unchanged and the PIPE-57 goldens hold (event names and runtimeActorId format byte-identical). Each subtask is independently shippable, in order.

Planning correction from the refactor review: the implementation scope is seven xstate import sites, not just the four machine files. Delete the machine files and rewrite the three actor callers: `src/pipeline-runtime.ts`, `src/runtime/gates/gates.ts`, and `src/runtime/hooks/hooks.ts`. The runtime actor/id/observability contract must be extracted before deletion by PIPE-59.5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/runtime-machines/ is deleted entirely and xstate is removed from package.json dependencies.
- [ ] #2 tests/pipeline-runtime.test.ts passes without modification; PIPE-57 golden event-record sequences are byte-identical.
- [ ] #3 failFast still forces serial execution (PIPE-57 test passes against the new scheduler).
- [ ] #4 The five subtasks (runtime contract extraction, gates/hooks inlining, node state tracker, scheduler replacement, observability emit rewiring) are complete in dependency order.
- [ ] #5 All seven xstate import sites are gone: `src/pipeline-runtime.ts`, `src/runtime/gates/gates.ts`, `src/runtime/hooks/hooks.ts`, `src/runtime-machines/workflow-machine.ts`, `src/runtime-machines/node-machine.ts`, `src/runtime-machines/gate-machine.ts`, and `src/runtime-machines/hook-machine.ts`.
- [ ] #6 No replacement introduces unsafe casts/assertions, broad fallback defaults, hidden retries, or duplicated scheduler condition clusters.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Keystone refactor: eliminates the dual-semantic-engine problem. Verified by reading all four machines: workflow-machine.ts is a ready-queue loop with 4 lifecycle hooks (all injected via callbacks, no xstate magic); node-machine.ts is a status recorder that sends events purely to update a string, then reads them back - the real retry decision happens in pure functions that are currently laundered through send/getSnapshot; gate-machine.ts and hook-machine.ts each wrap one promise in try/catch. The xstate inspection API is the ONLY real facility used (mapping @xstate.* to runtime.observability), and that is an output contract for events sent to Pipeline Console - not a state-management need. After this phase: one mental model (plain async), one node engine (used identically in local and pod paths), no xstate dependency. The five subtasks are independently shippable in order, each with its own regression gate. Subtask 3 (scheduler) also extracts workflow-lifecycle.ts as a shared module so Argo can use it in Phase 3 (PIPE-60).

Preserve public contract names and import surfaces. `runtimeActorId`, `RuntimeActorDescriptor`, `RuntimeActorKind`, `RuntimeObservabilityEvent`, and retry-policy contract types are not xstate concepts; they currently live beside machine declarations and must survive in a non-machine module. Do not rename actor IDs or event names while removing xstate.
<!-- SECTION:NOTES:END -->
