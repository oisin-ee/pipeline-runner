---
id: PIPE-50.6
title: Force OpenCode schedule planner output to package schema
status: To Do
assignee: []
created_date: '2026-06-06 09:54'
updated_date: '2026-06-06 09:54'
labels:
  - runner-job
  - opencode
  - schedule-planner
  - schema
dependencies: []
references:
  - src/schedule-planner.ts
  - src/config.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 135000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Direct no-console OpenCode runner Job `runner-50-4-20260606095012-opencode` used published image digest `sha256:5c0045e29abdf5b8201453314a40406f06e55a8df16d7948a0113837f04e2a3f` and did not hit the old OpenCode timeout. It failed at schedule validation because the OpenCode schedule planner emitted invalid package schema: command nodes used scalar `command` strings instead of string arrays, and agent nodes included unsupported node-level `instructions` fields.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The schedule planner prompt and/or parser boundary prevents generated command nodes with scalar `command` values.
- [ ] #2 The schedule planner prompt and/or parser boundary prevents generated workflow nodes from including unsupported `instructions` fields.
- [ ] #3 A regression test covers the OpenCode-style invalid schedule output and proves it is rejected with actionable repair or normalized before execution.
- [ ] #4 A direct no-console OpenCode runner Job reaches workflow node execution after schedule generation.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Trace the schedule planner output contract, repair/canonicalization path, and generated schedule validation. Fix the package schema boundary so OpenCode cannot produce syntactically plausible but invalid schedule YAML that blocks runner jobs before workflow execution.
<!-- SECTION:PLAN:END -->
