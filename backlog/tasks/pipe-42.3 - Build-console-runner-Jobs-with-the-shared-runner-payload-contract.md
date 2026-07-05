---
id: PIPE-42.3
title: Build console runner Jobs with the shared runner payload contract
status: Done
assignee: []
created_date: "2026-06-04 08:20"
updated_date: "2026-06-04 08:40"
labels:
  - console
  - contract
  - schema
dependencies:
  - PIPE-42.1
references:
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.test.ts
  - /Users/oisin/dev/pipeline-console/server/package.json
  - /Users/oisin/dev/pipeline-console/package.json
parent_task_id: PIPE-42
priority: high
ordinal: 103000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Replace pipeline-console's hand-built runner payload with the public oisin-pipeline runner Job contract. This ticket owns Pipeline Console adoption only; it should not modify the runner implementation.

The important production constraint is that @pipeline-console/server must have the contract package available where the production server build/runtime can import it, not only as a root devDependency.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 @pipeline-console/server declares the needed @oisincoveney/pipeline contract dependency for production build/runtime or documents an equivalent generated-contract import path
- [x] #2 runner-job-client.service.ts constructs OISIN_PIPELINE_RUNNER_PAYLOAD_JSON through buildRunnerJobPayload or validates the exact payload through runnerJobPayloadSchema before createNamespacedJob
- [x] #3 Console-created payloads include selector.allowCommandHooks only according to the shared contract and preserve requestedBy, eventSink, run, workflowId, task, repository, and Momokaya metadata behavior
- [x] #4 Invalid runner payload inputs are rejected before Kubernetes createNamespacedJob with a structured API/service error that route tests prove Pipeline Console can render
- [x] #5 Console contract/service tests fail if runner-job-client hand-builds a payload that the imported runner contract parser rejects
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

In /Users/oisin/dev/pipeline-console, update server/src/services/pipeline/runner-job-client.service.ts and related tests to import the shared runner payload contract from @oisincoveney/pipeline/runner-job-contract after PIPE-42.1 is published/linked. Reconcile Zod 3 vs Zod 4 by using exported builder/parser functions at the boundary instead of depending on raw schema internals where possible. Keep pipeline-console public request schema separate; it may accept allowCommandHooks, but runner payload serialization must be contract-owned.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

pipeline-console runner Job client now imports the shared contract builder, preserves allowCommandHooks false, includes sanitized repository/Momokaya context, and rejects invalid runner payloads before createNamespacedJob.

<!-- SECTION:FINAL_SUMMARY:END -->
