---
id: PIPE-40.11
title: Integrate workflow scheduler machine into runPipelineFromConfig
status: To Do
assignee: []
created_date: '2026-06-03 09:26'
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
- [ ] #1 runPipelineFromConfig creates a root XState actor system with a stable systemId for the pipeline run.
- [ ] #2 Workflow planned/start/finish events remain backward-compatible and are emitted from workflow actor lifecycle rather than imperative top-level calls.
- [ ] #3 Workflow start/success/failure/complete hooks run through hook actors and are visible in both domain observability events and existing hook.start/hook.finish events.
- [ ] #4 Batch scheduling, maxParallelNodes, fail_fast, cancellation before dependent scheduling, workflow-node children, parallel container nodes, and drain-merge behavior are owned by workflowSchedulerMachine.
- [ ] #5 Existing full pipeline-runtime test suite passes, including tracer-bullet, dogfood-installed, workflow nodes, parallel containers, fail_fast, cancellation, and hook ordering tests.
- [ ] #6 No hidden shared mutable scheduling state remains outside actor context except immutable config/plan inputs and accumulated final result snapshots.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Replace executeWorkflowBatches, executeWorkflowBatch, executeFailFastWorkflowBatch, and top-level workflow hook orchestration with workflowSchedulerMachine. Preserve public PipelineRuntimeResult derivation and reporter callback shape.
<!-- SECTION:PLAN:END -->
