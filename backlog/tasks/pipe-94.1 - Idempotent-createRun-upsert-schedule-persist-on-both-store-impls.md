---
id: PIPE-94.1
title: Idempotent createRun upsert + schedule persist on both store impls
status: Done
assignee: []
created_date: "2026-06-28 19:52"
updated_date: "2026-06-28 20:13"
labels: []
dependencies: []
modified_files:
  - src/run-control/run-control-store.ts
  - src/run-control/store.ts
  - src/run-control/postgres/postgres-run-control-store.ts
parent_task_id: PIPE-94
priority: high
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: RunControlStore.createRun becomes an idempotent upsert keyed by runId (second call with same runId returns the existing manifest, never errors/duplicates) and persists manifest.schedule when supplied. Foundation for the Hybrid createRun decision (submit + runner-lifecycle may both call it).
Dependencies: none
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 createRun called twice with same runId returns the same manifest, no error, no duplicate row -- Evidence: unit test on inMemory + fileRunControlStore + a Postgres store test (next-node-submit-result-pg style)
- [ ] #2 createRun persists manifest.schedule when provided; readRun returns it -- Evidence: unit test asserts manifest.schedule round-trips
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
