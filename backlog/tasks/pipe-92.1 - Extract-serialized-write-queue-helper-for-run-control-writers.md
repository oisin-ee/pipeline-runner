---
id: PIPE-92.1
title: Extract serialized write queue helper for run-control writers
status: To Do
assignee: []
created_date: '2026-06-26 22:05'
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
- [ ] #1 A queue contract test proves FIFO ordering, flush waits for pending writes, and enqueue-after-failure semantics -- Evidence: focused test output for serialized-write-queue
- [ ] #2 runtime-reporter, supervisor, and Postgres durable store use the shared helper while preserving current error behaviour -- Evidence: focused tests for run-control-runtime-reporter, supervised-run/run-control supervisor, and durable-store/postgres pass
- [ ] #3 run-state-lock and runner-event-sink are either intentionally left out with a source note or migrated with matching contract tests -- Evidence: grep result plus test output
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> targeted tests -> implementation -> quality-gate/critique -> verify
- [ ] #2 Proof commands recorded: bun run test tests/run-control-runtime-reporter.test.ts src/runtime/durable-store/postgres/postgres-store.test.ts src/run-control/run-state-lock.test.ts && bun run typecheck && bun run check
<!-- DOD:END -->
