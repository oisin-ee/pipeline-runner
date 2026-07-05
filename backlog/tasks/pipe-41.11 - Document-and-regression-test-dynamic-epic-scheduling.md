---
id: PIPE-41.11
title: Document and regression-test dynamic epic scheduling
status: Done
assignee: []
created_date: "2026-06-03 18:35"
updated_date: "2026-06-04 09:23"
labels:
  - docs
  - tests
  - schedules
dependencies:
  - PIPE-41.10
references:
  - docs/operator-guide.md
  - src/pipeline-init.ts
  - .pipeline/prompts/schedule-planner.md
  - tests/config.test.ts
  - tests/pipeline-init.test.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Update generated surfaces, operator guidance, and regression tests so dynamic epic scheduling remains stable.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Operator guide documents that scheduled entrypoints use constrained planner-generated schedules seeded by `baseline`
- [x] #2 Operator guide explains that scheduled epics write `.pipeline/runs/<runId>/schedule.yaml` and stop for approval
- [x] #3 Generated `pipe init` config and schedule-planner prompt match checked-in dynamic epic defaults
- [x] #4 Tests cover a multi-ticket epic schedule with distinct per-ticket branches and node `task_context`
- [x] #5 Tests cover rejected shortcut graphs and scaffolded config/prompt defaults
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update docs and generated prompt/config strings in the same slice as the tests. Keep examples small but representative: two backlog child tickets, two implementation branches, embedded workflows, and approval-before-execution wording.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Updated operator guidance, generated defaults, schedule-planner prompt defaults, and regression coverage for dynamic epic scheduling with per-ticket branches and `task_context`. Verified during backlog grooming on 2026-06-04 with `bun run typecheck`, `bun run check`, `bun run build`, `bun run test`, `bun run test:dogfood`, and CLI validation/explain of generated schedules.

<!-- SECTION:FINAL_SUMMARY:END -->
