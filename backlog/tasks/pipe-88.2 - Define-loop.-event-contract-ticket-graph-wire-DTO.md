---
id: PIPE-88.2
title: Define loop.* event contract + ticket-graph wire DTO
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
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
- [ ] #1 loop.* events validate via zod and carry runId/sequence/at like existing runner events -- Evidence: schema test round-trips each loop.* variant
- [ ] #2 serializeTicketGraph(TicketGraph) produces the wire DTO with batches from sequenceTicketBatchesEffect -- Evidence: unit test on a 3-node chain asserts nodes/edges/batches/dangling
- [ ] #3 loopState is a single discriminated enum owning node lifecycle -- Evidence: type test; no stringly-typed status
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on schema + serializer; record output
<!-- DOD:END -->
