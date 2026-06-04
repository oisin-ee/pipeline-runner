---
id: PIPE-41.12
title: Generate ticket-accurate epic schedules that validate in installed pipe
status: To Do
assignee: []
created_date: '2026-06-04 09:12'
updated_date: '2026-06-04 09:28'
labels:
  - pipeline
  - schedules
  - schedule-planning
  - backlog
  - dogfood
  - installed-pipe
  - scoped
dependencies:
  - PIPE-41.11
references:
  - src/schedule-planner.ts
  - src/config.ts
  - src/workflow-planner.ts
  - .pipeline/prompts/schedule-planner.md
  - src/pipeline-init.ts
  - tests/schedule-planner.test.ts
  - tests/config.test.ts
  - tests/cli.test.ts
modified_files:
  - src/schedule-planner.ts
  - src/config.ts
  - src/workflow-planner.ts
  - .pipeline/prompts/schedule-planner.md
  - src/pipeline-init.ts
  - tests/schedule-planner.test.ts
  - tests/config.test.ts
  - tests/cli.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 105000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dogfooding PC-37 exposed a broken epic scheduling setup. Running the epic entrypoint for PC-37 generated a generic four-track schedule instead of an explicit graph over PC-37.1 through PC-37.12. The expected explicit schedule had to be handwritten. The installed project pipe then rejected task_context fields even though local schedule-planner source and prompts describe assigning backlog work units with task_context.id. The fix is to make epic schedule generation expand Backlog child tickets into a dependency-accurate, runner-valid graph and keep schema, source, prompts, and installed behavior aligned. Evidence from pipeline-console: .pipeline/runs/run-20260604083002/schedule.yaml was generic; .pipeline/runs/run-20260604083002/pc-37-explicit-schedule.yaml validated only after removing task_context; pipe validate reported Unrecognized key: task_context before cleanup.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The epic entrypoint reads the epic and its Backlog child tickets, then generates explicit schedule nodes for every child ticket rather than only generic test/frontend/backend/k8s tracks.
- [ ] #2 Generated epic schedules preserve Backlog dependencies as node needs edges and fan out only independent child tickets.
- [ ] #3 Generated schedules validate with the same installed pipe validate --schedule command users will run; source schema, generated artifact schema, and installed package behavior agree on whether task context is supported.
- [ ] #4 If task_context is supported, generated schedules assign each work unit with task_context.id and hydrate title, description, and acceptance criteria; if unsupported, planner prompt and code do not mention it.
- [ ] #5 Regression tests cover a multi-child epic shaped like PC-37, including sequential contract/API dependencies, parallel independent branches, final rollout verification, and rejection of a generic four-track-only schedule.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Scoped implementation sequence:

1. `PIPE-41.12.1` establishes the Backlog work-unit contract by exposing child dependency metadata to the schedule planner prompt. This is the shared data contract for the remaining tickets.
2. `PIPE-41.12.2` uses that metadata to reject generic epic schedules and enforce dependency-preserving schedule edges while keeping independent child tickets parallelizable.
3. `PIPE-41.12.3` aligns `task_context` schema support across source parsing, workflow planning, generated defaults, public package exports, and the installed/user-facing CLI validation path.
4. `PIPE-41.12.4` proves the complete user path through built or installed `pipe`: generate a PC-37-shaped epic schedule, validate it, explain it, and assert it is ticket-accurate rather than generic-track-only.

Dependency batches: `.1` first; `.2` and `.3` can run after `.1` but both touch schedule-adjacent tests so assign them with separate worktrees and review overlap before merging; `.4` runs last after `.2` and `.3`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Backlog grooming on 2026-06-04 left this task open intentionally. Earlier `PIPE-41.1` through `PIPE-41.11` work is complete and current repo verification passes, but this ticket tracks the newer PC-37 dogfood failure where installed pipe behavior and generated schedule shape drifted.
<!-- SECTION:NOTES:END -->
