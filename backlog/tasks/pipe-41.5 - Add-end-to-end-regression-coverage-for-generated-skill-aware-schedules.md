---
id: PIPE-41.5
title: Add end-to-end regression coverage for generated skill-aware schedules
status: To Do
assignee: []
created_date: '2026-06-03 18:26'
labels:
  - pipeline
  - tests
  - phase-1
dependencies:
  - PIPE-41.1
  - PIPE-41.2
  - PIPE-41.4
references:
  - tests/config.test.ts
  - tests/pipeline-init.test.ts
  - tests/schedule-planner.test.ts
modified_files:
  - tests/config.test.ts
  - tests/pipeline-init.test.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a final regression layer that proves init, checked-in config, and schedule generation stay aligned after the profile and baseline changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `tests/config.test.ts` validates checked-in `pipe` and `epic` scheduled entrypoints still point at `pipe-schedule` and `epic-schedule` and that `epic-drain` remains available
- [ ] #2 `tests/pipeline-init.test.ts` validates newly scaffolded profiles and prompts contain the skill-aware defaults from PIPE-41.1 and PIPE-41.2
- [ ] #3 `tests/schedule-planner.test.ts` validates generated pipe and epic schedule artifacts compile through `compileScheduleArtifact` after planner output parsing
- [ ] #4 No test relies on a brittle full YAML snapshot; assertions target node ids, dependencies, profile ids, and gate kinds
- [ ] #5 Verification command for this ticket is `bun test tests/config.test.ts tests/pipeline-init.test.ts tests/schedule-planner.test.ts` or the repo-equivalent focused Vitest invocation
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Review the tests added in dependent tickets and fill any missing cross-surface assertions. Prefer focused structural assertions over snapshots so small formatting changes do not break the suite.
<!-- SECTION:PLAN:END -->
