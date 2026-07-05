---
id: PIPE-41.8
title: Resolve backlog child tickets for scheduled epics
status: Done
assignee: []
created_date: "2026-06-03 18:32"
updated_date: "2026-06-04 09:22"
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

- [x] #1 Schedule generation extracts a Backlog task id such as `PIPE-41` from the scheduled epic task
- [x] #2 The scheduler loads the parent and its child task contexts through Backlog integration
- [x] #3 Child contexts include id, title, description, and parsed acceptance criteria
- [x] #4 The planner prompt receives the resolved work units before asking for graph generation
- [x] #5 Prompt decomposition is used only when no Backlog epic id is referenced or no children can be resolved
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Reuse the existing task id parser. Add a deterministic Backlog resolver path suitable for local tests and future MCP/CLI wiring. Keep the scheduler generic by passing normalized work units to the planner instead of coupling runtime gates to Backlog.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added scheduled-epic Backlog task id extraction and child task context resolution so generated schedules can use Backlog work units as source of truth before prompt decomposition. Verified during backlog grooming on 2026-06-04 with tests plus CLI validation/explain of generated epic schedule `.pipeline/runs/run-20260603204455/schedule.yaml`.

<!-- SECTION:FINAL_SUMMARY:END -->
