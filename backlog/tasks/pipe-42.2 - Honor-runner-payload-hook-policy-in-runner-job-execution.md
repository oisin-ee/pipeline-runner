---
id: PIPE-42.2
title: Honor runner payload hook policy in runner-job execution
status: Done
assignee: []
created_date: "2026-06-04 08:20"
updated_date: "2026-06-04 08:40"
labels:
  - runner
  - schema
  - observability
dependencies:
  - PIPE-42.1
modified_files:
  - src/kubernetes-runner.ts
  - src/runner-job-contract.ts
  - tests/kubernetes-runner.test.ts
  - tests/runner-job-contract.test.ts
parent_task_id: PIPE-42
priority: high
ordinal: 102000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Wire the public runner Job payload contract into the Kubernetes runner entrypoint. This ticket owns runner-side behavior only: accepting the agreed selector field, passing it into runtime hook policy, and surfacing pre-runtime validation failures in a way Pipeline Console can render.

This is the slice that prevents valid inspect workflow runs from failing with selector.allowCommandHooks once the shared contract exists.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 A payload containing selector.workflowId=inspect and selector.allowCommandHooks=false parses successfully and calls runPipelineFromConfig with hookPolicy.allowCommandHooks=false
- [x] #2 Omitting selector.allowCommandHooks defaults to the documented runner behavior and existing valid payloads remain compatible
- [x] #3 Invalid selector fields still fail before runtime execution with structured validation details, not a bare Zod message only
- [x] #4 When eventSink and run identity are recoverable from an invalid payload, runner-job posts a schema-validation runner event and terminal failure summary before exiting 64
- [x] #5 Runner tests cover the original failed Momokaya payload shape and prove no Kubernetes API calls are made by the in-pod job
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update src/kubernetes-runner.ts to use the contract parser result and pass selector.allowCommandHooks into runPipelineFromConfig({ hookPolicy }). Extend runner event records or log/runtime event mapping only as needed for pre-runtime validation observability. Add focused tests in tests/kubernetes-runner.test.ts and tests/runner-job-contract.test.ts using the exact failure payload shape from PIPE-42. Do not change pipeline-console in this ticket.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Runner now accepts selector.allowCommandHooks, passes hookPolicy.allowCommandHooks into runtime, and emits runner.schema.validation plus workflow.finish for recoverable schema failures before exiting 64.

<!-- SECTION:FINAL_SUMMARY:END -->
