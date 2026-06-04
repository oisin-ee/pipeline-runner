---
id: PIPE-41.7
title: Propagate node-level task context
status: Done
assignee: []
created_date: '2026-06-03 18:31'
updated_date: '2026-06-04 09:22'
labels:
  - pipeline
  - runtime
  - schedules
dependencies:
  - PIPE-41.6
references:
  - src/config.ts
  - src/workflow-planner.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/workflow-planner.test.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Allow workflow nodes to carry canonical task context so dynamically generated schedules can attach a Backlog child ticket to the branch that implements it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Workflow-node schema accepts optional `task_context` with `id`, `title`, `description`, and `acceptance_criteria: [{ id, text }]`
- [x] #2 The workflow planner preserves node context in planned nodes, including parallel children
- [x] #3 Agent prompts render node-specific context when present instead of only inherited parent context
- [x] #4 `kind: workflow` nodes pass their `task_context` into nested workflow execution
- [x] #5 Acceptance gates evaluate against the node-specific context when one is present
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add the config schema field, normalize planned context to the existing runtime `PipelineTaskContext` shape, and route it through prompt rendering, nested workflow creation, hook payloads, and acceptance gate evaluation. Add focused tests at each public seam.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Propagated node-level task context through config schema, workflow planning, runtime prompt rendering, nested workflow execution, and acceptance gate context selection. Verified during backlog grooming on 2026-06-04 with tests plus CLI validation/explain of generated single-ticket schedule `.pipeline/runs/run-20260603204951/schedule.yaml`.
<!-- SECTION:FINAL_SUMMARY:END -->
