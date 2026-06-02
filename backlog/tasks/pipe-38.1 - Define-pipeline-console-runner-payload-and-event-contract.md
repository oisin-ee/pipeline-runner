---
id: PIPE-38.1
title: Define pipeline-console runner payload and event contract
status: Done
assignee: []
created_date: '2026-06-01 21:03'
updated_date: '2026-06-02 20:41'
labels:
  - pipeline
  - runner
  - contract
  - console-integration
dependencies: []
references:
  - src/pipeline-runtime.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-run-control.service.ts
  - /Users/oisin/dev/pipeline-console/contracts/src/pipeline/run.ts
modified_files:
  - src/runner-job-contract.ts
  - tests/runner-job-contract.test.ts
  - docs/pipeline-console-runner-contract.md
parent_task_id: PIPE-38
priority: high
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Add the shared runner contract module that validates the exact payload emitted by completed `pipeline-console` runner Jobs and defines how `PipelineRuntimeEvent` values become console event records.

## Payload shape to support

Completed `pipeline-console` code sets a single environment variable named `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`:

```json
{
  "eventSink": {
    "authHeader": "Authorization",
    "url": "https://console.example/api/pipeline/runner-events"
  },
  "run": {
    "projectId": "alpha",
    "requestedBy": "@agent",
    "runId": "run-uid-1"
  },
  "selector": {
    "workflowId": "epic-drain"
  },
  "task": {
    "prompt": "PC-27",
    "taskId": "PC-27"
  }
}
```

The console currently passes `workflowId`, not `entrypoint`, after resolving the requested entrypoint against the target project's `.pipeline/pipeline.yaml`.

## Event append shape to produce

`pipeline-console` accepts:

```json
{
  "events": [
    {
      "sequence": 1,
      "type": "node.started",
      "node": { "id": "research", "status": "running" }
    }
  ]
}
```

The service requires a strictly increasing integer `sequence`, uses `at` or `timestamp` if present, stores all other fields as event payload, and authenticates using the configured header. The runner contract must therefore make sequence assignment and payload passthrough explicit.

## Token source

The console Job payload includes sink URL and header name, not a token. Define the runner-side token lookup order as:

1. `OISIN_PIPELINE_EVENT_AUTH_TOKEN`
2. `PIPELINE_EVENT_API_TOKEN`
3. readable Kubernetes service account token at `/var/run/secrets/kubernetes.io/serviceaccount/token`

If none is present, contract validation must fail before starting the runtime.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `src/runner-job-contract.ts` exports zod schemas and TypeScript types for `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`, event sink config, run identity, workflow selector, and task prompt.
- [x] #2 Validation rejects missing `eventSink.url`, missing `run.runId`, missing `run.projectId`, missing `selector.workflowId`, missing `task.prompt`, invalid URLs, and payloads that set unsupported selector modes.
- [x] #3 The contract exports a `RunnerEventRecord` type with required `sequence`, required `type`, optional `at`, and passthrough payload fields compatible with `pipeline-console`'s `eventRecordFromRequest`.
- [x] #4 The event mapping spec covers at least workflow start/finish, workflow plan, node start/finish, gate start/finish, artifact output, log output, failure, and cancellation using console-detail-friendly fields: `workflowPlan`, `node`, `gate`, `artifact`, `log`, and `finalResult`.
- [x] #5 Tests parse the exact payload shape produced by `runner-job-client.service.ts` and reject representative malformed payloads without touching runtime execution.
- [x] #6 `docs/pipeline-console-runner-contract.md` records the payload, labels, event batch shape, auth token lookup order, and the fact that the console owns Job creation and event storage.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented src/runner-job-contract.ts with zod payload schemas, typed RunnerEventRecord variants, event mapping to console-friendly fields, token lookup helpers, contract docs, and focused tests. Review fix removed the lossy singular mapper and made workflow.planned emit plan plus edge records through the plural mapper.
<!-- SECTION:FINAL_SUMMARY:END -->
