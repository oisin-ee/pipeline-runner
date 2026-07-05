---
id: PIPE-41.10
title: Validate generated schedule policy coverage
status: Done
assignee: []
created_date: "2026-06-03 18:34"
updated_date: "2026-06-04 09:23"
labels:
  - pipeline
  - validation
  - schedules
dependencies:
  - PIPE-41.9
references:
  - src/schedule-planner.ts
  - src/workflow-planner.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 98000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Reject unsafe or shortcut `agent_graph` planner output before writing or executing a schedule artifact.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Generated schedules reject workflow references that are not embedded in the artifact
- [x] #2 Generated schedules reject cycles and invalid dependency graphs
- [x] #3 Generated schedules reject profile ids and workflow ids outside the loaded config
- [x] #4 Generated schedules reject missing assigned backlog work units
- [x] #5 Generated schedules reject implementation branches without downstream acceptance, verification, or review
- [x] #6 Validation failures explain the rejected policy violation with actionable task or node ids
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Layer policy validation in schedule generation and keep generic DAG validation in `compileScheduleArtifact`/`compileWorkflowPlan`. Add regression tests for missing work units and shortcut implementation graphs.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added generated schedule policy validation for missing embedded workflows, cycles, invalid ids, missing work-unit assignments, missing downstream verification/review, and actionable failure messages. Verified during backlog grooming on 2026-06-04 with the full repository verification suite and generated schedule CLI validation.

<!-- SECTION:FINAL_SUMMARY:END -->
