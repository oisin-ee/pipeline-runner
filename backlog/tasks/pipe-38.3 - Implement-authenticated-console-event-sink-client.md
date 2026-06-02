---
id: PIPE-38.3
title: Implement authenticated console event sink client
status: Done
assignee: []
created_date: '2026-06-01 21:04'
updated_date: '2026-06-02 20:41'
labels:
  - pipeline
  - runner
  - events
  - console-integration
dependencies:
  - PIPE-38.1
references:
  - src/pipeline-runtime.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-run-control.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-event-store.service.ts
  - /Users/oisin/dev/pipeline-console/contracts/src/pipeline/run.ts
modified_files:
  - src/runner-event-sink.ts
  - tests/runner-event-sink.test.ts
parent_task_id: PIPE-38
priority: high
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Implement the runner-side event sink that turns `PipelineRuntimeEvent` callbacks into authenticated event batches accepted by completed `pipeline-console`.

## Behavior

- Maintain one strictly increasing sequence counter per runner process, starting at `1`.
- Convert runtime events into `RunnerEventRecord` values defined in PIPE-38.1.
- POST JSON batches to `payload.eventSink.url`.
- Set the configured auth header from `payload.eventSink.authHeader`.
- Send bearer auth as `Bearer <token>` using the token source defined in PIPE-38.1.
- Preserve runtime timestamps where present; otherwise add `at: new Date().toISOString()`.
- Flush all buffered events when the runtime finishes, fails before completion, or is cancelled.

## Failure policy

The runner should retry transient HTTP/network failures with bounded backoff. Authentication failures, malformed responses, and repeated retry exhaustion are terminal runner failures because the console would otherwise show a Kubernetes Job without durable event history.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `src/runner-event-sink.ts` exports a reporter-compatible sink factory that accepts the validated runner payload and returns `{ reporter, flush, fail }` or an equivalent explicit lifecycle API.
- [x] #2 The sink posts `{ events: [...] }` batches whose items include integer `sequence`, string `type`, timestamp, and console-detail-friendly payload fields.
- [x] #3 The sink sets `Authorization: Bearer <token>` by default and honors a non-default `eventSink.authHeader` from the payload.
- [x] #4 Tests use an injected `fetch` implementation to cover sequence assignment, batching, auth header, timestamp fallback, retryable failures, terminal 401/403 failures, and final flush ordering.
- [x] #5 Event mapping tests prove that workflow plan, node, gate, artifact, log, final PASS/FAIL, and cancellation events reconstruct through the console fields used by `runner-run-control.service.ts`.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented src/runner-event-sink.ts with ordered batching, injected fetch, bearer auth using the configured header, retry/terminal failure policy, final flush behavior, and tests for sequencing, batching, auth, retry, terminal 401/403, mapping, and cancellation. Review fix made authToken required and kept token lookup in runner preparation only.
<!-- SECTION:FINAL_SUMMARY:END -->
