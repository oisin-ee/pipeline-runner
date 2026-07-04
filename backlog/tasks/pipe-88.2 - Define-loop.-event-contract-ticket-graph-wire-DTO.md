---
id: PIPE-88.2
title: Define loop.* event contract + ticket-graph wire DTO
status: Done
assignee: []
created_date: '2026-06-21 19:27'
updated_date: '2026-07-04 19:42'
labels: []
dependencies: []
modified_files:
  - src/runner-event-schema.ts
  - src/tickets/ticket-graph.ts
parent_task_id: PIPE-88
priority: high
ordinal: 246000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: src/runner-event-schema.ts (add loop.start, loop.graph.snapshot, loop.node.transition, loop.finish), new ticket-graph DTO serializer in src/tickets/ (nodes[{id,title,status,priority,loopState}], edges[{from,to}], batches[[id]], dangling[]). loopState enum: queued|running|merging|passed|blocked. Shared schema consumed by controller (emit) + console (render). Reuse sequenceTicketBatchesEffect for batch levels.
Dependencies: none
Escalation: report Met/Unmet with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 loop.* events validate via zod and carry runId/sequence/at like existing runner events -- Evidence: schema test round-trips each loop.* variant
- [x] #2 serializeTicketGraph(TicketGraph) produces the wire DTO with batches from sequenceTicketBatchesEffect -- Evidence: unit test on a 3-node chain asserts nodes/edges/batches/dangling
- [x] #3 loopState is a single discriminated enum owning node lifecycle -- Evidence: type test; no stringly-typed status
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
DONE. loop.* event contract + ticket-graph wire DTO defined and shared.

Evidence:
- src/runner-event-schema.ts:194-234 — loop.* detail + record variants: loop.start, loop.graph.snapshot, loop.node.transition, loop.finish; each carries runId/sequence/at like existing runner events.
- src/tickets/ticket-graph-dto.ts:18-33 — loopStateSchema single z.enum(["queued","running","merging","passed","blocked"]) documented as "the SINGLE exported source of truth for node lifecycle"; serializeTicketGraph produces nodes[{id,title,status,priority,loopState}]/edges/batches/dangling wire DTO with batches from the sequence machinery.
- Shared, not duplicated: pipeline-console consumes these types directly via @oisincoveney/pipeline/events (../pipeline-console/contracts/src/pipeline/loop-event.ts:1-30 re-exports RunnerEventRecord and Extracts each loop.* variant).
- Tests green: src/runner-event-schema.test.ts (10 passed), src/tickets/ticket-graph-dto.test.ts (8 passed).

All AC met: schema round-trips each loop.* variant, serializer covered on a chain, loopState is one discriminated enum (no stringly-typed status).
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on schema + serializer; record output
<!-- DOD:END -->
