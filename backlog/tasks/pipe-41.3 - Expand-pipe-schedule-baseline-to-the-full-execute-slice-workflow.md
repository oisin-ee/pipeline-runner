---
id: PIPE-41.3
title: Expand pipe schedule baseline to the full execute-slice workflow
status: To Do
assignee: []
created_date: '2026-06-03 18:25'
labels:
  - pipeline
  - schedule
  - phase-1
dependencies: []
references:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
modified_files:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 91000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make generated `$pipe` schedule artifacts use the same full execution shape as the checked-in default workflow instead of the compressed research to implement to verify baseline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `pipeBaselineWorkflow()` emits root nodes in order: `research`, `red`, `green`, `acceptance`, `verify`, `learn`
- [ ] #2 The `red` node uses `pipeline-test-writer` and carries the same changed-files test policy as `.pipeline/pipeline.yaml` default workflow
- [ ] #3 The `green` node uses `pipeline-code-writer` and depends on `red`
- [ ] #4 The `acceptance` node uses `pipeline-acceptance-reviewer` and carries acceptance and verdict gates
- [ ] #5 The `verify` node carries typecheck, test, semgrep, duplication, and verdict gates matching the checked-in default workflow
- [ ] #6 `tests/schedule-planner.test.ts` proves generated pipe schedules compile and expose the expanded node ids and gates
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Refactor `src/schedule-planner.ts` to build the execute-slice nodes through a small helper so pipe and epic track baselines can share the graph without copy-paste drift. Update schedule planner tests to expect the expanded pipe baseline.
<!-- SECTION:PLAN:END -->
