---
id: PIPE-91.4
title: Postgres durable-store impl + migrations
status: Done
assignee: []
created_date: "2026-06-26 17:21"
updated_date: "2026-06-26 20:17"
labels: []
dependencies:
  - PIPE-91.1
  - PIPE-91.3
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - package.json
  - src/runtime/durable-store/postgres/postgres-store.ts
  - src/runtime/durable-store/postgres/migrations
parent_task_id: PIPE-91
priority: high
ordinal: 278000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation (library-first-development: research + vet pg/postgres.js + Drizzle/Kysely BEFORE hand-rolling SQL or a migration runner)
Scope: implement the PIPE-91.1 DurableRunStore over cluster Postgres. Borrow PERSISTENCE only (decision #8): a pg/postgres.js client + Drizzle OR Kysely for typed migrations; steal DBOS's step-keyed-checkpoint idea (record inputs for deterministic re-run), NOT an orchestration engine. Schema: a run table + a node-record table keyed (runId,nodeId) storing inputs, outputs (RuntimeNodeResult), criteria, status, timestamps. Connection from the global db.url (PIPE-91.3). Migrations runnable + idempotent. No hand-rolled migration runner if a maintained one exists.
SHARED CLUSTER DB (locked decision, 2026-06-26): integration tests point db.url at a REAL cluster Postgres — no testcontainers, no tunnel. ASSUMES a cluster test DB + credentials exist and are reachable from the dev/CI runner (see epic open question on provisioning).
RISK — shared-state contention: many runs and many test workers share one DB, so parallel work must not collide on the (runId,nodeId) primary key. Isolation mechanism: each run already has a unique runId; tests additionally namespace by a unique per-test runId prefix (generated/ULID) OR a test-scoped Postgres schema (search_path), so concurrent record/read/resume never bleeds across runs.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + Postgres integration tests ran fresh; output recorded
<!-- DOD:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Postgres impl satisfies the PIPE-91.1 contract against a real PG -- Evidence: integration test records + reads + resumes via Postgres, same assertions as the in-memory suite
- [ ] #2 Migrations create the schema idempotently from a clean DB -- Evidence: migration applied twice on a fresh DB without error; schema asserted
- [ ] #3 Library chosen via library-first vetting, not hand-rolled -- Evidence: notes record the vetted lib + version; deps added to package.json
- [ ] #4 Integration tests run against the real cluster Postgres via db.url (no testcontainer or tunnel) -- Evidence: integration test connects using the configured cluster db.url and records/reads a node record
- [ ] #5 Parallel runs/tests do not collide on (runId,nodeId) on the shared cluster DB -- Evidence: integration test runs two runs concurrently with distinct runId namespaces and asserts each reads only its own records
<!-- AC:END -->
