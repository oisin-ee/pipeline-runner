---
id: PIPE-40.9
title: Integrate hook and gate machines into runtime services
status: To Do
assignee: []
created_date: '2026-06-03 09:26'
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
- [ ] #1 dispatchHooks or its replacement runs hooks through hookInvocationMachine actors with observable state transitions.
- [ ] #2 evaluateNodeGates or its replacement runs configured gates through gateEvaluationMachine actors with observable state transitions.
- [ ] #3 Existing hook and gate PipelineRuntimeEvent variants remain backward-compatible.
- [ ] #4 New observability events are emitted for hook and gate state transitions through the bridge and public mapping.
- [ ] #5 Existing pipeline-runtime hook and gate tests pass, including required hook failure, optional hook behavior, trust policy, command gates, artifact gates, schema gates, semantic verdict, acceptance coverage, changed-file policies, cancellation, and output limits.
- [ ] #6 No unsafe casts, disabled checks, swallowed errors, or compatibility shims are introduced.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Modify src/pipeline-runtime.ts only around hook and gate execution seams. Prefer extracting runtime service adapters into src/runtime-machines/runtime-services.ts if needed. Keep node execution and workflow scheduling imperative until their later integration tickets.
<!-- SECTION:PLAN:END -->
