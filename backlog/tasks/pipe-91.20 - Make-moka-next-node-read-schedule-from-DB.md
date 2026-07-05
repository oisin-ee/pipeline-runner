---
id: PIPE-91.20
title: Make moka next node read schedule from DB
status: Done
assignee: []
created_date: "2026-06-28 09:04"
updated_date: "2026-06-28 10:35"
labels: []
dependencies:
  - PIPE-91.19
references:
  - src/run-control/next-node.ts
  - src/run-control/contracts.ts
  - src/runtime/node-protocol/node-protocol.ts
modified_files:
  - src/run-control/next-node.ts
  - src/run-control/commands.ts
  - src/run-control/submit-result.ts
  - tests/next-node-submit-result-pg.test.ts
parent_task_id: PIPE-91
priority: high
ordinal: 318000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: change moka next node from --schedule-file handoff to runId-only DB lookup of manifest.schedule, then compile that schedule and compute next ready node from durable results.
Dependencies: PIPE-91.19
Likely modified files: src/run-control/next-node.ts; src/run-control/commands.ts; src/run-control/submit-result.ts; tests/next-node-submit-result-pg.test.ts; src/run-control/next-node.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 moka next node <runId> works without --schedule-file by reading manifest.schedule from RunControlStore -- Evidence: CLI/unit test seeds DB manifest.schedule and asserts emitted NextNodeEnvelope for first ready node
- [x] #2 --schedule-file is removed or rejected with migration guidance; no default stepping path accepts repo-local schedule files -- Evidence: command help snapshot and rg show no active --schedule-file requirement for moka next node
- [x] #3 next-node + submit-result round-trip advances across separate processes using only DB state -- Evidence: Postgres integration test runs next-node, submit-result, next-node from separate invocations and asserts dependent node appears
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Dispatch completion evidence (2026-06-28):

- AC1/AC3: `bunx vitest run tests/next-node.test.ts tests/next-node-submit-result-pg.test.ts` with live `MOKA_PG_TEST_URL` through `kubectl port-forward -n momokaya svc/momokaya-db-rw 55432:5432` => 2 test files passed, 18 tests passed. The live command-actions test seeds `moka_run_control_run.manifest.schedule`, runs `moka next node <runId>` through Commander without `--schedule-file`, records `plan` through `moka submit-result`, and runs `moka next node <runId>` again to emit `implement` with upstream output from DB state.
- AC2: `tests/next-node.test.ts` asserts `moka next node --help` omits `--schedule-file`; legacy `--schedule-file` is rejected as an unknown Commander option with migration guidance: remove the flag because schedules are read from the Moka DB by run id. `rg -n -- "--schedule-file|scheduleFile" src/run-control tests/next-node.test.ts tests/next-node-submit-result-pg.test.ts` shows only the rejection test and migration guidance, no active run-control schedule-file path.
- Static checks: `bun run typecheck` => `tsc --noEmit`, exit 0; `bun run check` => 469 files checked, no fixes; `git diff --check` => clean.
- Reuse: used existing `RunControlStore.readRun`, `resolveRunControlStore`, `resolveDurableStore`, `compileScheduleArtifact`, Commander unknown-option validation, and Effect scoped store lifecycles; no new dependency.
<!-- SECTION:NOTES:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the ticket's global-rules workflow in order
- [x] #2 Run bun test tests/next-node-submit-result-pg.test.ts plus next-node focused tests and bun run typecheck; record output
<!-- DOD:END -->
