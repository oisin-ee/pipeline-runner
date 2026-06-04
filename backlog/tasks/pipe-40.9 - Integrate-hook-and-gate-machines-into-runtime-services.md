---
id: PIPE-40.9
title: Integrate hook and gate machines into runtime services
status: Done
assignee: []
created_date: '2026-06-03 09:26'
updated_date: '2026-06-04 09:21'
labels:
  - xstate
  - runtime
  - hooks
  - gates
  - integration
dependencies:
  - PIPE-40.3
  - PIPE-40.5
  - PIPE-40.8
references:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
modified_files:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace imperative hook and gate lifecycle dispatch inside the runtime with the hookInvocationMachine and gateEvaluationMachine while preserving existing hook/gate behavior and public runtime results.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dispatchHooks or its replacement runs hooks through hookInvocationMachine actors with observable state transitions.
- [x] #2 evaluateNodeGates or its replacement runs configured gates through gateEvaluationMachine actors with observable state transitions.
- [x] #3 Existing hook and gate PipelineRuntimeEvent variants remain backward-compatible.
- [x] #4 New observability events are emitted for hook and gate state transitions through the bridge and public mapping.
- [x] #5 Existing pipeline-runtime hook and gate tests pass, including required hook failure, optional hook behavior, trust policy, command gates, artifact gates, schema gates, semantic verdict, acceptance coverage, changed-file policies, cancellation, and output limits.
- [x] #6 No unsafe casts, disabled checks, swallowed errors, or compatibility shims are introduced.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Modify src/pipeline-runtime.ts only around hook and gate execution seams. Prefer extracting runtime service adapters into src/runtime-machines/runtime-services.ts if needed. Keep node execution and workflow scheduling imperative until their later integration tickets.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Integrated hook and gate machines into runtime services while preserving existing public hook/gate behavior and adding actor observability events. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.
<!-- SECTION:FINAL_SUMMARY:END -->
