---
id: PIPE-91.4
title: Postgres durable-store impl + migrations
status: To Do
assignee: []
created_date: '2026-06-26 17:21'
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
Scope: implement the PIPE-91.1 DurableRunStore over cluster Postgres. Borrow PERSISTENCE only (decision #8): a pg/postgres.js client + Drizzle OR Kysely for typed migrations; steal DBOS's step-keyed-checkpoint idea (record inputs for deterministic re-run), NOT an orchestration engine. Schema: a run table + a node-record table keyed (runId,nodeId) storing inputs, outputs (RuntimeNodeResult), criteria, status, timestamps. Connection from db.url (PIPE-91.3). Migrations runnable + idempotent. No hand-rolled migration runner if a maintained one exists.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Postgres impl satisfies the PIPE-91.1 contract against a real PG -- Evidence: integration test records + reads + resumes via Postgres, same assertions as the in-memory suite
- [ ] #2 Migrations create the schema idempotently from a clean DB -- Evidence: migration applied twice on a fresh DB without error; schema asserted
- [ ] #3 Library chosen via library-first vetting, not hand-rolled -- Evidence: notes record the vetted lib + version; deps added to package.json
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + Postgres integration tests ran fresh; output recorded
<!-- DOD:END -->
