---
id: PIPE-38.4
title: Wire Kubernetes cancellation to runtime abort and final event flush
status: Done
assignee: []
created_date: "2026-06-01 21:04"
updated_date: "2026-06-02 20:41"
labels:
  - pipeline
  - runner
  - cancellation
  - k8s
dependencies:
  - PIPE-38.2
  - PIPE-38.3
references:
  - src/pipeline-runtime.ts
  - src/runner.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-run-control.service.ts
modified_files:
  - src/kubernetes-runner.ts
  - src/runner-event-sink.ts
  - tests/kubernetes-runner.test.ts
  - tests/runner-event-sink.test.ts
parent_task_id: PIPE-38
priority: high
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## What

Make Kubernetes Job deletion or process termination produce a clean runtime cancellation instead of a dropped process.

Completed `pipeline-console` cancellation deletes the runner Job and records a console-side `run.cancelled` event. The runner still needs to handle `SIGTERM`/`SIGINT` while the container is alive so in-flight runtime work receives `AbortSignal`, buffered events flush, and the process exits deterministically.

## Behavior

- Create one `AbortController` for the runner process.
- On first `SIGTERM` or `SIGINT`, abort the runtime signal, append a cancellation/final-result event, flush the event sink, and exit `130`.
- On a second termination signal, stop waiting for graceful flush and exit immediately.
- If the runtime returns `CANCELLED` without a process signal, emit the same final cancellation event and exit `130`.
- Do not recreate or patch Kubernetes Jobs; the console owns Job cancellation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 The runner entrypoint passes an `AbortSignal` to `runPipelineFromConfig` and the signal is aborted on `SIGTERM` and `SIGINT`.
- [x] #2 A first termination signal causes an ordered cancellation event and final result event to be flushed before process exit when the sink is reachable.
- [x] #3 A second termination signal exits without hanging on network I/O or child process cleanup.
- [x] #4 Tests simulate `SIGTERM`, `SIGINT`, runtime `CANCELLED`, flush success, flush failure, and double-signal behavior without spawning real Kubernetes Jobs.
- [x] #5 The implementation does not change the console cancellation API or the existing runtime's public outcome values.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Wired SIGTERM/SIGINT to an AbortController in the runner job, records cancellation/final result events, flushes before graceful 130 exit, force exits on a second signal, handles runtime CANCELLED, and preserves console-owned Job cancellation boundaries. Covered by kubernetes runner and event sink tests.

<!-- SECTION:FINAL_SUMMARY:END -->
