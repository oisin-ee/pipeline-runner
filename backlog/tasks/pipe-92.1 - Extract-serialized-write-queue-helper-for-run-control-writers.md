---
id: PIPE-92.1
title: Extract serialized write queue helper for run-control writers
status: Done
assignee: []
created_date: '2026-06-26 22:05'
updated_date: '2026-06-26 23:26'
labels: []
dependencies: []
references:
  - src/run-control/runtime-reporter.ts
  - src/run-control/supervisor.ts
  - src/runtime/durable-store/postgres/postgres-store.ts
  - src/run-control/run-state-lock.ts
  - 'https://effect.website/docs/concurrency/queue/'
  - 'https://github.com/sindresorhus/p-queue'
modified_files:
  - src/serialized-write-queue.ts
  - src/run-control/runtime-reporter.ts
  - src/run-control/supervisor.ts
  - src/runtime/durable-store/postgres/postgres-store.ts
parent_task_id: PIPE-92
priority: medium
ordinal: 290000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: classify existing Promise-chain serializers, then extract only the shared FIFO enqueue/flush behaviour used by run-control reporter, run-control supervisor, and Postgres durable store. Preserve each caller-specific error policy; do not fold run-state-lock or runner-event-sink unless their semantics are proven identical.
Dependencies: none
Likely modified files: src/serialized-write-queue.ts, src/run-control/runtime-reporter.ts, src/run-control/supervisor.ts, src/runtime/durable-store/postgres/postgres-store.ts, tests for those modules
Library-first note: prefer existing effect primitives or a tiny local helper over a new dependency; p-queue/bottleneck were evaluated and are not a narrow fit here.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A queue contract test proves FIFO ordering, flush waits for pending writes, and enqueue-after-failure semantics -- Evidence: focused test output for serialized-write-queue
- [x] #2 runtime-reporter, supervisor, and Postgres durable store use the shared helper while preserving current error behaviour -- Evidence: focused tests for run-control-runtime-reporter, supervised-run/run-control supervisor, and durable-store/postgres pass
- [x] #3 run-state-lock and runner-event-sink are either intentionally left out with a source note or migrated with matching contract tests -- Evidence: grep result plus test output
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented in commit 1957e2d. Added createSerializedWriteQueue and contract tests proving FIFO, flush drain, and failure recovery. Migrated runtime-reporter, supervisor, and Postgres durable store to the shared helper; run-state-lock and runner-event-sink intentionally left out with source notes because their lock/batch-retry semantics differ. Proof: bun run test src/serialized-write-queue.test.ts tests/run-control-runtime-reporter.test.ts tests/run-control-heartbeats.test.ts src/runtime/durable-store/postgres/postgres-store.test.ts src/run-control/run-state-lock.test.ts tests/runner-event-sink.test.ts passed 26 tests with 7 infra-gated Postgres tests skipped because MOKA_PG_TEST_URL is unset; bun run typecheck passed; bun run check exited 0 but checked 0 files in this worktree.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> targeted tests -> implementation -> quality-gate/critique -> verify
- [x] #2 Proof commands recorded: bun run test tests/run-control-runtime-reporter.test.ts src/runtime/durable-store/postgres/postgres-store.test.ts src/run-control/run-state-lock.test.ts && bun run typecheck && bun run check
<!-- DOD:END -->
