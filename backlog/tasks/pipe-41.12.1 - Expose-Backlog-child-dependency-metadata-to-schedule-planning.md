---
id: PIPE-41.12.1
title: Expose Backlog child dependency metadata to schedule planning
status: To Do
assignee: []
created_date: '2026-06-04 09:27'
updated_date: '2026-06-04 09:27'
labels:
  - pipeline
  - schedules
  - backlog
  - contract
dependencies:
  - PIPE-41.11
references:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
  - src/task-ref.ts
modified_files:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41.12
priority: high
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the schedule planner receive enough canonical Backlog context to preserve child-ticket ordering for multi-child epics. PC-37 exposed that child tickets must be treated as work units with dependency metadata, not just as an unordered list of ids and acceptance criteria. This ticket owns the planning-context contract only; it does not change schedule graph validation beyond proving the metadata is loaded and passed to the planner.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A Backlog child task's declared dependencies are parsed into the schedule planning work-unit context using Backlog task metadata, not by scraping arbitrary prose.
- [ ] #2 The planner prompt serializes each work unit with its id, title, description, acceptance criteria, and dependency ids when dependencies exist.
- [ ] #3 Single-ticket schedules such as `PIPE-41.7` still use only the exact requested ticket as the work unit and do not pull sibling dependencies into the prompt.
- [ ] #4 Tests cover a PC-37-shaped fixture with at least one sequential dependency and two independent child tickets, and assert the planner prompt contains the dependency metadata.
- [ ] #5 The implementation uses existing `gray-matter`, `yaml`, and Zod/config parsing patterns already in the repo; no new parser dependency or ad hoc markdown parser is introduced.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend the internal `BacklogWorkUnit` shape in `src/schedule-planner.ts` to include dependency ids loaded from task frontmatter.
2. Update the local Backlog task fixture helpers in `tests/schedule-planner.test.ts` so a child task can declare dependencies in frontmatter.
3. Add a PC-37-shaped test fixture with sequential and independent children, then assert the prompt's `Backlog work units` block carries dependency ids.
4. Preserve the existing single-ticket behavior: dotted ids such as `PIPE-41.7` remain exact-ticket work units when they have no children.
5. Run focused schedule planner tests and the repo validation commands required by the parent ticket.
<!-- SECTION:PLAN:END -->
