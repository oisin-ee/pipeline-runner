---
id: PIPE-84.3
title: Implement deterministic ready-ticket selector
status: Done
assignee: []
created_date: '2026-06-17 10:37'
updated_date: '2026-06-17 12:35'
labels:
  - moka
  - ticket
  - selection
dependencies:
  - PIPE-84.1
  - PIPE-84.2
references:
  - src/tickets/ticket-graph.ts
modified_files:
  - src/tickets/ticket-selection.ts
  - tests/ticket-selection.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 236000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the pure selection policy behind moka ticket next. Selection must be deterministic, agent-free, and read-only unless the CLI layer later calls it with an explicit claim command.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A ticket is ready only when status is To Do and all dependency tickets are Done; evidence: tests/ticket-selection.test.ts asserts blocked and unblocked states.
- [x] #2 Parent epics with incomplete children are excluded from ready-ticket results unless an explicit option includes parents; evidence: selector tests cover parent epic exclusion.
- [x] #3 Default ordering is priority high to medium to low, then ordinal, then natural Backlog id; evidence: selector tests assert stable ordering including PIPE-2 before PIPE-10.
- [x] #4 Supports priority, bfs, and dfs strategies with documented tie-breaking; evidence: tests assert each strategy on the same rooted fixture graph.
- [x] #5 Repeated read-only selection returns the same ticket and does not mutate task state; evidence: pure function tests call selection twice and assert identical output.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/tickets/ticket-selection.ts. Keep the selector pure over task store and graph output. No hidden cursor, no filesystem writes, and no BacklogService dependency in this module.
<!-- SECTION:PLAN:END -->
