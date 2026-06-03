---
id: PIPE-41.8
title: Resolve backlog child tickets for scheduled epics
status: To Do
assignee: []
created_date: '2026-06-03 18:32'
labels:
  - backlog
  - pipeline
  - schedules
dependencies:
  - PIPE-41.7
references:
  - src/schedule-planner.ts
  - src/backlog.ts
  - src/task-ref.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Scheduled `$epic` runs should treat Backlog child tasks as the source of truth when the user task references an epic id.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Schedule generation extracts a Backlog task id such as `PIPE-41` from the scheduled epic task
- [ ] #2 The scheduler loads the parent and its child task contexts through Backlog integration
- [ ] #3 Child contexts include id, title, description, and parsed acceptance criteria
- [ ] #4 The planner prompt receives the resolved work units before asking for graph generation
- [ ] #5 Prompt decomposition is used only when no Backlog epic id is referenced or no children can be resolved
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Reuse the existing task id parser. Add a deterministic Backlog resolver path suitable for local tests and future MCP/CLI wiring. Keep the scheduler generic by passing normalized work units to the planner instead of coupling runtime gates to Backlog.
<!-- SECTION:PLAN:END -->
