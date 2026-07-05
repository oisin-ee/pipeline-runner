---
id: PIPE-91.19
title: Make local moka run persist schedules directly to DB
status: Done
assignee: []
created_date: "2026-06-28 09:04"
updated_date: "2026-06-28 10:11"
labels: []
dependencies:
  - PIPE-91.17
  - PIPE-91.18
references:
  - src/cli/run-service.ts
  - src/runtime/journal-acquisition.ts
  - tests/moka-resume-schedule.test.ts
modified_files:
  - src/cli/run-service.ts
  - src/run-control/detach.ts
  - tests/cli.test.ts
  - tests/detached-run.test.ts
  - tests/moka-resume-schedule.test.ts
parent_task_id: PIPE-91
priority: high
ordinal: 317000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: migrate local supervised and detached moka run paths from .pipeline/runs schedule handoff to in-memory schedule YAML persisted through RunControlStore.createRun({ schedule }).
Dependencies: PIPE-91.17, PIPE-91.18
Likely modified files: src/cli/run-service.ts; src/run-control/detach.ts; tests/cli.test.ts; tests/detached-run.test.ts; tests/moka-resume-schedule.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Scheduled local run uses generated in-memory YAML and never writes or reads .pipeline/runs/<runId>/schedule.yaml -- Evidence: focused CLI test asserts no .pipeline directory is created and output no longer says Schedule generated: .pipeline/runs/...
- [x] #2 RunControlStore.createRun receives the serialized schedule before execution for both supervised and detached paths -- Evidence: tests assert manifest.schedule is populated in the DB-backed store for generated and explicit schedules
- [x] #3 moka resume rebuilds the graph from manifest.schedule and does not depend on a worktree schedule file -- Evidence: moka-resume-schedule test kills a custom generated schedule, resumes from DB, and runs only unfinished nodes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Dispatch completion evidence (2026-06-28):

- AC1/AC2/AC3: `bunx vitest run tests/cli.test.ts tests/detached-run.test.ts tests/moka-resume-schedule.test.ts` with live `MOKA_PG_TEST_URL` through `kubectl port-forward -n momokaya svc/momokaya-db-rw 55432:5432` => 3 test files passed, 58 tests passed.
- AC3 focused proof: `bunx vitest run tests/moka-resume-schedule.test.ts` with the same live PG URL => 1 test passed. The test persists `manifest.schedule` in `moka_run_control_run`, seeds `step-one` in the durable journal, resumes by `runId` + DB URL, and asserts only unfinished custom-graph nodes run while `pkg-default` never runs.
- Static checks: `bun run typecheck` => `tsc --noEmit`, exit 0; `bun run check` => 469 files checked, no fixes; `git diff --check` => clean.
- Reuse: used existing `generateScheduleArtifactInMemory`, `RunControlStore.createRun({ schedule })`, `postgresRunControlStore`, and `postgresDurableRunStore`; no new dependency.
<!-- SECTION:NOTES:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the ticket's global-rules workflow in order
- [x] #2 Run bun test tests/cli.test.ts tests/detached-run.test.ts tests/moka-resume-schedule.test.ts and bun run typecheck; record output
<!-- DOD:END -->
