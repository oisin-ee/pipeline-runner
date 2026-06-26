---
id: PIPE-91.8
title: moka resume — rehydrate run state from Postgres and continue
status: To Do
assignee: []
created_date: '2026-06-26 17:22'
updated_date: '2026-06-26 18:38'
labels: []
dependencies:
  - PIPE-91.4
  - PIPE-91.5
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/run-control/commands.ts
  - src/pipeline-runtime.ts
parent_task_id: PIPE-91
priority: high
ordinal: 282000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: a CLI subcommand (run-control registry) that rehydrates a run's state from the durable store (PIPE-91.4) and continues it with the DEFAULT spawn-and-run executor (decision #1 production plug) — reusing the scheduler's existing resume-from-completed seed (resumeCompleted, already wired in PIPE-91.5). Cross-invocation: a run killed in one process resumes in another straight from Postgres.
SHARED CLUSTER DB (locked decision, 2026-06-26): the kill/resume integration test runs against a REAL cluster Postgres pointed at by db.url — no testcontainer/tunnel. ASSUMES a cluster test DB + credentials exist (epic open question). RISK — shared-state contention: the fresh-process resume reads the same shared DB other runs/tests use, so the test must namespace its runId (unique generated prefix or test-scoped schema) so resume rehydrates only its own (runId,nodeId) records.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 moka resume <runId> continues a persisted run; already-passed nodes are not re-run -- Evidence: integration test kills a multi-node run, resumes in a fresh process, asserts only unfinished nodes execute
- [ ] #2 Resume with an unknown/absent runId fails with a clear error -- Evidence: test asserts the error message + nonzero exit
- [ ] #3 Resume runs against the real cluster Postgres via db.url (no testcontainer/tunnel) and rehydrates only its own (runId,nodeId) records under a unique per-test runId namespace, so a concurrent run on the shared DB is not picked up -- Evidence: fresh-process resume test with a namespaced runId asserts no cross-run bleed
<!-- AC:END -->



## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + resume integration tests ran fresh; output recorded
<!-- DOD:END -->
