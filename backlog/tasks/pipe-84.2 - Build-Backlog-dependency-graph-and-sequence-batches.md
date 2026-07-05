---
id: PIPE-84.2
title: Build Backlog dependency graph and sequence batches
status: Done
assignee: []
created_date: "2026-06-17 10:37"
updated_date: "2026-06-17 12:35"
labels:
  - moka
  - ticket
  - backlog
  - graph
dependencies:
  - PIPE-84.1
references:
  - src/schedule/backlog-context.ts
  - src/planning/generate.ts
modified_files:
  - src/tickets/ticket-graph.ts
  - tests/ticket-graph.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 235000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Build the graph layer for moka ticket commands from the reusable Backlog task store. The graph must model task dependency edges and parent/child containment enough to validate graph health and compute execution batches deterministically.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Builds a graph from Backlog dependency frontmatter and parent/child relationships; evidence: tests/ticket-graph.test.ts asserts nodes and edges for a representative epic with children.
- [x] #2 Detects missing dependency references and cycles with errors naming affected ticket ids; evidence: tests assert missing dependency and cycle failure messages.
- [x] #3 Computes dependency execution batches with independent leaves in the same batch and dependent tickets in later batches; evidence: tests assert stable batch output.
- [x] #4 Matches backlog sequence list --plain semantics where comparable; evidence: fixture verification compares moka batch ordering to backlog sequence output for the same temp Backlog.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add src/tickets/ticket-graph.ts. Use @dagrejs/graphlib already present in package dependencies. Keep invalid graphs invalid; do not silently serialize all tickets as a fallback.

<!-- SECTION:PLAN:END -->
