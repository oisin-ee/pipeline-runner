---
id: PIPE-40.11
title: Integrate workflow scheduler machine into runPipelineFromConfig
status: Done
assignee: []
created_date: "2026-06-03 09:26"
updated_date: "2026-06-04 09:21"
labels:
  - xstate
  - runtime
  - workflow
  - integration
dependencies:
  - PIPE-40.7
  - PIPE-40.10
references:
  - src/pipeline-runtime.ts
  - src/workflow-planner.ts
  - tests/pipeline-runtime.test.ts
modified_files:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 84000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make workflowSchedulerMachine own workflow lifecycle, batch scheduling, fail-fast, cancellation, workflow hooks, and final outcome while preserving the public runPipelineFromConfig API and result shape.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 runPipelineFromConfig creates a root XState actor system with a stable systemId for the pipeline run.
- [x] #2 Workflow planned/start/finish events remain backward-compatible and are emitted from workflow actor lifecycle rather than imperative top-level calls.
- [x] #3 Workflow start/success/failure/complete hooks run through hook actors and are visible in both domain observability events and existing hook.start/hook.finish events.
- [x] #4 Batch scheduling, maxParallelNodes, fail_fast, cancellation before dependent scheduling, workflow-node children, parallel container nodes, and drain-merge behavior are owned by workflowSchedulerMachine.
- [x] #5 Existing full pipeline-runtime test suite passes, including tracer-bullet, dogfood-installed, workflow nodes, parallel containers, fail_fast, cancellation, and hook ordering tests.
- [x] #6 No hidden shared mutable scheduling state remains outside actor context except immutable config/plan inputs and accumulated final result snapshots.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Replace executeWorkflowBatches, executeWorkflowBatch, executeFailFastWorkflowBatch, and top-level workflow hook orchestration with workflowSchedulerMachine. Preserve public PipelineRuntimeResult derivation and reporter callback shape.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Integrated the workflow scheduler machine into `runPipelineFromConfig`, preserving public result/reporter behavior while actor-owned scheduling handles batches, fail-fast, hooks, cancellation, nested workflows, parallel containers, and drain merge. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.

<!-- SECTION:FINAL_SUMMARY:END -->
