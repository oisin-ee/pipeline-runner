---
id: PIPE-19.3
title: Compile workflow YAML into a deterministic DAG execution plan
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - planner
  - dag
dependencies:
  - PIPE-19.1
references:
  - src/mastra/pipeline-primitive.ts
  - src/pipeline-spec.ts
parent_task_id: PIPE-19
priority: high
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the workflow planner that turns validated YAML workflows into deterministic execution plans. The planner must support sequential and parallel node execution through `needs`, reject cycles, preserve stable ordering, and expose enough plan metadata for dry-run/explain output and runtime execution.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Workflow nodes compile into a deterministic DAG with stable topological ordering.
- [ ] #2 Cycles, orphan dependencies, duplicate ids, and unreachable malformed groups fail validation before execution.
- [ ] #3 Independent nodes are identified as parallelizable without changing deterministic gate behavior.
- [ ] #4 The planner supports node kinds `agent`, `command`, `builtin`, and `group`.
- [ ] #5 Tests prove the default workflow order and a representative parallel workflow compile correctly.
<!-- AC:END -->
