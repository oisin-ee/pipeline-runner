---
id: PIPE-41.12.2
title: Reject generic epic schedules and enforce Backlog dependency edges
status: Done
assignee: []
created_date: "2026-06-04 09:27"
updated_date: "2026-06-04 09:48"
labels:
  - pipeline
  - schedules
  - validation
  - backlog
dependencies:
  - PIPE-41.12.1
references:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
modified_files:
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41.12
priority: high
ordinal: 107000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make generated epic schedules ticket-accurate when Backlog child work units are available. The scheduler must reject a generic four-track schedule that does not assign every child ticket, and it must reject schedules that allow a child ticket to run before the Backlog tickets it depends on. This ticket owns generated schedule policy validation and planner guidance; it does not own installed package validation.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 When a scheduled epic has Backlog child work units, generated schedules that contain only generic track nodes and omit child `task_context.id` assignments are rejected with an actionable error listing the missing child ids.
- [x] #2 For each Backlog child dependency, validation requires a directed schedule path from at least one node assigned the prerequisite ticket to every implementation node assigned the dependent ticket.
- [x] #3 Independent Backlog child tickets can still fan out in the same execution batch when no dependency path is declared between them.
- [x] #4 The schedule-planner prompt tells planners to preserve Backlog dependency ids as `needs` edges and to fan out only independent child tickets.
- [x] #5 Regression tests cover a PC-37-shaped graph with sequential contract/API dependencies, parallel independent implementation branches, and rejection of a generic four-track-only schedule.
- [x] #6 No compatibility fallback silently drops dependency metadata or converts invalid dependency graphs into serial all-ticket chains.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Add a policy-validation helper in `src/schedule-planner.ts` that checks declared work-unit dependency ids against the generated workflow graph.
2. Define the graph rule precisely: dependent implementation nodes assigned `task_context.id = B` must have a directed dependency path from at least one node assigned each prerequisite id declared by B.
3. Add explicit error messages that name the dependent ticket id, prerequisite ticket id, and generated node ids involved.
4. Update `.pipeline/prompts/schedule-planner.md` and the generated prompt string in `src/pipeline-init.ts` only if the current prompt does not already state the dependency-edge requirement clearly enough; otherwise keep this ticket limited to `src/schedule-planner.ts` and tests.
5. Add PC-37-shaped positive and negative tests in `tests/schedule-planner.test.ts` for sequential and independent children.
6. Run `bun test tests/schedule-planner.test.ts`, then the parent verification commands before completion.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Execution started after `PIPE-41.12.1` green test. Next red test targets generated schedule validation for Backlog child dependency edges.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Generated schedule validation now rejects Backlog child dependency violations and generic schedules that omit child assignments. The planner prompt instructs agents to preserve Backlog dependency ids as `needs` edges, and validation requires implementation nodes for dependent work units to have a directed path from prerequisite work-unit nodes while independent tickets can still fan out. Verification included PC-37-shaped positive/negative schedule planner tests and the full repository verification suite.

<!-- SECTION:FINAL_SUMMARY:END -->
