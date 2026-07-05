---
id: PIPE-40.8
title: Map runtime observability events into public runner events
status: Done
assignee: []
created_date: "2026-06-03 09:26"
updated_date: "2026-06-04 09:21"
labels:
  - xstate
  - observability
  - console
  - events
dependencies:
  - PIPE-40.4
references:
  - src/runner-job-contract.ts
  - src/runner-event-sink.ts
modified_files:
  - src/runner-job-contract.ts
  - tests/runner-job-contract.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Extend the public event mapping so stable XState-derived runtime observability events can be consumed by CLI/reporters and the console event sink without exposing raw XState inspection payloads as the external API.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 PipelineRuntimeEvent or a sibling exported public event type can carry stable observability events defined by PIPE-40.2 without breaking existing event variants.
- [x] #2 runner-job-contract maps new state, actor, hook, gate, retry, and snapshot observability events into top-level RunnerEventRecord fields or clearly named log records.
- [x] #3 Large outputs and sensitive hook/stdout payloads are redacted or summarized according to the bridge policy from PIPE-40.4.
- [x] #4 Existing runner event sink tests continue to pass unchanged except where they intentionally assert new event support.
- [x] #5 New tests cover mapping node.state.entered, hook.started, hook.finished, node.retry.scheduled, actor.snapshot, and actor.event.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update src/runner-job-contract.ts and tests/runner-job-contract.test.ts. Only adjust src/pipeline-runtime.ts if the public event union must import shared observability types; do not integrate machines in this ticket.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Mapped stable runtime observability events into the public runner event contract without exposing raw XState inspection payloads. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.

<!-- SECTION:FINAL_SUMMARY:END -->
