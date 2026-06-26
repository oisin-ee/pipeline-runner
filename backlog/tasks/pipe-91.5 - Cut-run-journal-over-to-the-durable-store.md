---
id: PIPE-91.5
title: Cut run-journal over to the durable store
status: To Do
assignee: []
created_date: '2026-06-26 17:21'
updated_date: '2026-06-26 18:38'
labels: []
dependencies:
  - PIPE-91.1
  - PIPE-91.4
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/pipeline-runtime.ts
  - src/runtime/run-journal.ts
parent_task_id: PIPE-91
priority: high
ordinal: 279000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: route resolveRunJournal (src/pipeline-runtime.ts:201) to select the Postgres store when global db.url is set, else the in-memory/file path — all THROUGH the PIPE-91.1 seam so the scheduler (src/runtime/scheduler.ts) stays untouched (the journal/runNode seam already exists). Migrate run-journal.ts callers to the unified store and deprecate the JSONL path. MUST NOT break live/in-flight runs: when db.url is absent, behaviour is byte-identical to today.
Scope is the run-journal (terminal-result) substrate. The run-control store (src/run-control/store.ts) cutover is now IN the epic too but is a SEPARATE lane (PIPE-91.12); this ticket and that one touch disjoint files and run in parallel.
SHARED CLUSTER DB (locked decision, 2026-06-26): the db.url path is verified against a REAL cluster Postgres — no testcontainer/tunnel. ASSUMES a cluster test DB + credentials exist (epic open question). RISK — shared-state contention: kill/resume tests run concurrently against one DB, so each test must namespace its runId (unique generated prefix or test-scoped schema) to avoid colliding on (runId,nodeId).
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With db.url set, a run records terminal node results to Postgres and resumes from it -- Evidence: integration test kills + resumes a run via the Postgres store; finished nodes are not re-run
- [ ] #2 With db.url absent, behaviour is byte-identical to today (file/in-memory journal) -- Evidence: existing pipeline-runtime + scheduler journal tests pass unchanged
- [ ] #3 Scheduler stays untouched (durability stays behind the seam) -- Evidence: scheduler.ts unchanged in diff; pnpm run check green
- [ ] #4 Kill/resume tests run against the real cluster Postgres via db.url (no testcontainer/tunnel) and isolate run-state by a unique per-test runId namespace so parallel tests do not collide on (runId,nodeId) -- Evidence: two concurrent kill/resume tests with distinct runId prefixes each resume only their own records
<!-- AC:END -->



## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + pipeline-runtime + journal/cutover tests ran fresh; output recorded
<!-- DOD:END -->
