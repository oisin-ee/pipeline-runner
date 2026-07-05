---
id: PIPE-19.3
title: Compile workflow YAML into a deterministic DAG execution plan
status: Done
assignee: []
created_date: "2026-05-24 14:17"
updated_date: "2026-05-25 09:16"
labels:
  - pipeline
  - planner
  - dag
dependencies:
  - PIPE-19.1
references:
  - src/mastra/pipeline-primitive.ts
  - src/pipeline-spec.ts
modified_files:
  - src/workflow-planner.ts
  - tests/workflow-planner.test.ts
  - >-
    backlog/tasks/pipe-19.3 -
    Compile-workflow-YAML-into-a-deterministic-DAG-execution-plan.md
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

- [x] #1 Workflow nodes compile into a deterministic DAG with stable topological ordering.
- [x] #2 Cycles, orphan dependencies, duplicate ids, and unreachable malformed groups fail validation before execution.
- [x] #3 Independent nodes are identified as parallelizable without changing deterministic gate behavior.
- [x] #4 The planner supports node kinds `agent`, `command`, `builtin`, and `group`.
- [x] #5 Tests prove the default workflow order and a representative parallel workflow compile correctly.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add a pure workflow planner that compiles a validated `PipelineConfig` workflow into a deterministic DAG execution plan. The planner should preserve declaration-order tie breaking, produce topological order plus parallel batches, support `agent`, `command`, `builtin`, and `group` nodes, and fail with structured planner errors for missing workflows, duplicate ids, orphan dependencies, cycles, and malformed group references.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented a pure workflow planner that compiles validated YAML workflows into deterministic DAG execution plans with stable topological order, parallel batches, dependency/dependent metadata, and support for agent, command, builtin, and group nodes. Added structured planner errors and coverage for default workflow order, parallel execution batches, missing workflows, duplicate ids, orphan dependencies, cycles, and malformed group references.

<!-- SECTION:FINAL_SUMMARY:END -->
