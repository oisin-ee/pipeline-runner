---
id: PIPE-40
title: 'Epic: XState v5 runtime actor system and observability'
status: Done
assignee: []
created_date: '2026-06-03 09:24'
updated_date: '2026-06-04 09:22'
labels:
  - epic
  - xstate
  - runtime
  - observability
dependencies: []
references:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
documentation:
  - 'https://stately.ai/docs/setup'
  - 'https://stately.ai/docs/actors'
  - 'https://stately.ai/docs/invoke'
  - 'https://stately.ai/docs/inspection'
  - 'https://stately.ai/docs/system'
  - 'https://stately.ai/docs/tags'
priority: high
ordinal: 73000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the hand-rolled runtime execution lifecycle with an XState v5 actor system. The long-term goal is explicit workflow/node/attempt/gate/hook states, first-class hook actors, XState inspection for actor-level diagnostics, and stable domain observability events for CLI/console consumers. This is not a cosmetic reducer replacement; XState must own the lifecycle and retry model.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runtime execution is modeled as XState v5 actors using setup(...).createMachine(...).
- [x] #2 Node, hook, gate, workflow batch, retry, cancellation, and terminal phases are represented as explicit states.
- [x] #3 Raw XState inspection is available for diagnostics and mapped separately from stable public runtime events.
- [x] #4 Existing PipelineRuntimeResult and existing public PipelineRuntimeEvent behavior remains backward-compatible unless a subtask explicitly adds new events with tests.
- [x] #5 The old transitionNode/reduceNodeState/p-retry node orchestration path is removed by the end of the epic.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement in dependency-ordered slices: ADR and contracts, machine modules, observability bridge, node integration, hook/gate integration, workflow scheduler integration, cleanup, and documentation.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Completed the XState v5 runtime actor-system epic. Runtime lifecycle ownership moved to XState actors for workflow, node, hook, and gate execution; stable observability remains separated from raw XState inspection; public runtime behavior is preserved; obsolete imperative lifecycle and retry paths were removed; and the actor model is documented. Backlog grooming verification on 2026-06-04 passed `bun run typecheck`, `bun run check`, `bun run build`, `bun run test` (24 files, 331 tests), and `bun run test:dogfood` (4 tests).
<!-- SECTION:FINAL_SUMMARY:END -->
