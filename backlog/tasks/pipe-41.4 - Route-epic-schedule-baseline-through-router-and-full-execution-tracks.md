---
id: PIPE-41.4
title: Route epic schedule baseline through router and full execution tracks
status: Done
assignee: []
created_date: "2026-06-03 18:25"
updated_date: "2026-06-04 09:22"
labels:
  - pipeline
  - schedule
  - epic
  - phase-1
dependencies:
  - PIPE-41.3
references:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
modified_files:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 92000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make generated `$epic` schedule artifacts match the checked-in epic-drain intent: research the epic, route sub-tickets, fan out track workflows, merge, and review.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 `epicBaselineWorkflow()` root nodes are `research`, `plan`, `implement`, `merge`, and `review`
- [x] #2 The `plan` node uses `pipeline-epic-router` and depends on `research`
- [x] #3 The `implement` parallel node depends on `plan` and contains `test`, `frontend`, `backend`, and `k8s` workflow children with isolated worktree roots
- [x] #4 The embedded track workflow uses the same full execute-slice nodes from PIPE-41.3: `research`, `red`, `green`, `acceptance`, `verify`, `learn`
- [x] #5 The merge node remains `kind: builtin` with `builtin: drain-merge`, and review remains `pipeline-thermo-nuclear-reviewer` with a verdict gate
- [x] #6 `tests/schedule-planner.test.ts` proves generated epic schedules compile, reference only embedded workflows, and expose the router plus expanded track node ids
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Reuse the execute-slice helper introduced by PIPE-41.3 for the embedded `track` workflow. Update the root epic baseline to include the router node and move the parallel fan-out dependency from `research` to `plan`. Extend schedule planner tests for the generated epic artifact.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Routed generated `$epic` baselines through research, routing, expanded execution tracks, drain merge, and review. Verified during backlog grooming on 2026-06-04 with tests plus CLI validation/explain of generated epic schedule `.pipeline/runs/run-20260603204455/schedule.yaml`.

<!-- SECTION:FINAL_SUMMARY:END -->
