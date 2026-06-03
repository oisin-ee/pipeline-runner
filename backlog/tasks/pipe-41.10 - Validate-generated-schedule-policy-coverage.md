---
id: PIPE-41.10
title: Validate generated schedule policy coverage
status: To Do
assignee: []
created_date: '2026-06-03 18:34'
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
- [ ] #1 Generated schedules reject workflow references that are not embedded in the artifact
- [ ] #2 Generated schedules reject cycles and invalid dependency graphs
- [ ] #3 Generated schedules reject profile ids and workflow ids outside the loaded config
- [ ] #4 Generated schedules reject missing assigned backlog work units
- [ ] #5 Generated schedules reject implementation branches without downstream acceptance, verification, or review
- [ ] #6 Validation failures explain the rejected policy violation with actionable task or node ids
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Layer policy validation in schedule generation and keep generic DAG validation in `compileScheduleArtifact`/`compileWorkflowPlan`. Add regression tests for missing work units and shortcut implementation graphs.
<!-- SECTION:PLAN:END -->
