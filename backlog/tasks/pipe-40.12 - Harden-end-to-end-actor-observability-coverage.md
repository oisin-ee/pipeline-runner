---
id: PIPE-40.12
title: Harden end-to-end actor observability coverage
status: Done
assignee: []
created_date: '2026-06-03 09:27'
updated_date: '2026-06-04 09:21'
labels:
  - xstate
  - runtime
  - observability
  - tests
dependencies:
  - PIPE-40.11
references:
  - tests/pipeline-runtime.test.ts
  - tests/runner-job-contract.test.ts
  - tests/runner-event-sink.test.ts
modified_files:
  - tests/pipeline-runtime.test.ts
  - tests/runner-job-contract.test.ts
  - tests/runner-event-sink.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 85000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add end-to-end coverage proving the XState actor system provides useful observability through the existing runtime, CLI, and console event paths.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A pipeline-runtime integration test asserts the ordered observability path for a successful node: ready, startingHooks, runnerRunning, runnerFinished, gatesRunning, successHooks, passed.
- [x] #2 A pipeline-runtime integration test asserts retry observability: failed attempt, retrying, retry scheduled with delay metadata, second attempt, terminal passed or retry exhausted.
- [x] #3 A cancellation test asserts workflow and node actors enter cancelled states and do not schedule dependent nodes after abort.
- [x] #4 A hook failure test asserts hook actor state and public hook.finish event agree on required failure evidence.
- [x] #5 A runner-job-contract or runner-event-sink test proves new observability events are delivered without raw unredacted snapshots.
- [x] #6 Full bun run test passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Extend tests/pipeline-runtime.test.ts, tests/runner-job-contract.test.ts, and tests/runner-event-sink.test.ts only where needed. Prefer observable public events and final snapshots over private implementation assertions.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hardened end-to-end actor observability coverage across runtime, retry, cancellation, hook failure, and runner event delivery paths. Verified during backlog grooming on 2026-06-04 with `bun run test` passing 24 test files and 331 tests, plus `bun run test:dogfood`.
<!-- SECTION:FINAL_SUMMARY:END -->
