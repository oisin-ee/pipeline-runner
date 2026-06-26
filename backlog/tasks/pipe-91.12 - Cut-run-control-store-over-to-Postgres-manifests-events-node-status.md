---
id: PIPE-91.12
title: Cut run-control store over to Postgres (manifests/events/node-status)
status: To Do
assignee: []
created_date: '2026-06-26 18:39'
labels: []
dependencies:
  - PIPE-91.10
  - PIPE-91.11
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/run-control/store.ts
  - src/run-control/commands.ts
parent_task_id: PIPE-91
priority: high
ordinal: 286000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: cut the run-control store (src/run-control/store.ts — manifests, events, node-status, node-session, node-artifacts) over to the PIPE-91.11 Postgres impl THROUGH the PIPE-91.10 seam, so the run-control command surface (src/run-control/commands.ts: runs/status/logs/stop/export) and the scheduler stay untouched. Select the Postgres store when the global db.url is set, else the existing filesystem store. MUST NOT break live/in-flight runs: when db.url is absent, behaviour is byte-identical to today (.pipeline/runs file store).
GATE BLAST RADIUS (locked decision, 2026-06-26): the changed-files gate special-cases .pipeline/ run-state (SUPERVISOR_RUN_STATE_GLOBS in src/runtime/gates/kinds/changed-files/changed-files.ts). Once run-control state lives in Postgres it no longer writes .pipeline/runs in the worktree (when db.url is set), but the gate MUST still exclude run-state (for the db.url-absent file path) and MUST still gate genuine node-authored output under .pipeline/. A verify AC covers this.
SHARED CLUSTER DB: integration tests point db.url at a REAL cluster Postgres — no testcontainer/tunnel. ASSUMES a cluster test DB + credentials exist (epic open question). RISK — shared-state contention: cutover tests run concurrently against one DB, so each namespaces its runId (unique prefix or test-scoped schema) to avoid colliding on (runId,nodeId).
This lane is DISJOINT from the journal cutover (PIPE-91.5: src/pipeline-runtime.ts + run-journal.ts vs this ticket's src/run-control/store.ts + commands.ts), so the two run in parallel once their shared deps (PIPE-91.4 / PIPE-91.11) land.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With db.url set, run-control manifest/events/node-status persist to + rehydrate from Postgres through the PIPE-91.10 seam -- Evidence: integration test creates a run, records events, reads it back from Postgres in a fresh process
- [ ] #2 With db.url absent, behaviour is byte-identical to today (.pipeline/runs filesystem store) -- Evidence: existing run-control + commands tests pass unchanged
- [ ] #3 Run-control command surface + scheduler untouched (store selection behind the seam) -- Evidence: commands public behaviour unchanged; pnpm run check green
- [ ] #4 changed-files gate still excludes run-state after the move: SUPERVISOR_RUN_STATE_GLOBS still hide the db.url-absent .pipeline/runs path AND genuine node-authored output under .pipeline/ is still gated -- Evidence: changed-files gate test asserts run-state excluded and a node-authored .pipeline/ file still flagged
- [ ] #5 Cutover tests run against the real cluster Postgres via db.url (no testcontainer/tunnel) and isolate by unique runId namespace so parallel tests do not collide on (runId,nodeId) -- Evidence: two concurrent cutover tests with distinct runId prefixes stay isolated
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + run-control cutover + changed-files gate tests ran fresh; output recorded
<!-- DOD:END -->
