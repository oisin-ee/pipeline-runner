---
id: PIPE-91.11
title: Postgres run-control store impl + migrations
status: Done
assignee: []
created_date: "2026-06-26 18:39"
updated_date: "2026-06-26 20:34"
labels: []
dependencies:
  - PIPE-91.10
  - PIPE-91.3
  - PIPE-91.4
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/run-control/postgres/postgres-run-control-store.ts
  - src/run-control/postgres/migrations
parent_task_id: PIPE-91
priority: high
ordinal: 285000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation (library-first-development: reuse the pg client + migration runner vetted in PIPE-91.4, do not introduce a second DB stack)
Scope: implement the PIPE-91.10 RunControlStore contract over cluster Postgres, reusing the pg/postgres.js client + Drizzle/Kysely migration substrate established in PIPE-91.4 (one DB stack, decision #8). Schema: a run-manifest table + an append-only event table (preserving the event-sourced replay model — events recorded then replayed via replayEvents into a manifest), plus node-session and node-artifact storage keyed (runId,nodeId). Connection from the global db.url (PIPE-91.3). Migrations runnable + idempotent, co-located with the PIPE-91.4 migrations so a single migrate step provisions both stores.
SHARED CLUSTER DB (locked decision, 2026-06-26): integration tests point db.url at a REAL cluster Postgres — no testcontainers, no tunnel. ASSUMES a cluster test DB + credentials exist (epic open question). RISK — shared-state contention: many runs/test workers share the DB, so parallel work must not collide on (runId,nodeId); tests namespace by a unique per-test runId prefix or a test-scoped schema (search_path).
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Postgres impl satisfies the PIPE-91.10 contract against a real PG -- Evidence: integration test exercises createRun/recordEvent/readRun/listRuns + node session/artifact via Postgres, same assertions as the filesystem suite
- [ ] #2 Event-sourced model preserved: an append-only event table replays into a manifest -- Evidence: integration test records events then reads the replayed manifest from Postgres
- [ ] #3 Migrations idempotent and co-located with the PIPE-91.4 migrations (single migrate step provisions both stores) -- Evidence: combined migration applied twice on a fresh DB without error; both stores' schemas asserted
- [ ] #4 Reuses the PIPE-91.4 pg client + migration runner (one DB stack, no second framework) -- Evidence: notes show the shared client; no new DB dependency added
- [ ] #5 Integration tests run against the real cluster Postgres via db.url (no testcontainer/tunnel); parallel runs/tests isolate by unique runId namespace so they do not collide on (runId,nodeId) -- Evidence: two concurrent run-control tests with distinct runId prefixes each read only their own state
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + Postgres run-control integration tests ran fresh; output recorded
<!-- DOD:END -->
