---
id: PIPE-91.5
title: Cut run-journal over to the durable store
status: To Do
assignee: []
created_date: '2026-06-26 17:21'
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
Scope: route resolveRunJournal (src/pipeline-runtime.ts:201) to select the Postgres store when db.url is set, else the in-memory/file path — all THROUGH the PIPE-91.1 seam so the scheduler (src/runtime/scheduler.ts) stays untouched (the journal/runNode seam already exists). Migrate run-journal.ts callers to the unified store and deprecate the JSONL path. MUST NOT break live/in-flight runs: when db.url is absent, behaviour is byte-identical to today.
NOTE: scope is the run-journal (terminal-result) substrate per design. Whether the run-control store (src/run-control/store.ts) ALSO moves to Postgres is an epic open question and is NOT in this ticket.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With db.url set, a run records terminal node results to Postgres and resumes from it -- Evidence: integration test kills + resumes a run via the Postgres store; finished nodes are not re-run
- [ ] #2 With db.url absent, behaviour is byte-identical to today (file/in-memory journal) -- Evidence: existing pipeline-runtime + scheduler journal tests pass unchanged
- [ ] #3 Scheduler stays untouched (durability stays behind the seam) -- Evidence: scheduler.ts unchanged in diff; pnpm run check green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + pipeline-runtime + journal/cutover tests ran fresh; output recorded
<!-- DOD:END -->
