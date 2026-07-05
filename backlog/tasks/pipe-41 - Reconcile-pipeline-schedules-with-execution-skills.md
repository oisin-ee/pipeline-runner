---
id: PIPE-41
title: Agent-driven workflow scheduling
status: Done
assignee: []
created_date: "2026-06-03 18:24"
updated_date: "2026-06-04 09:48"
labels:
  - epic
  - pipeline
  - skills
dependencies: []
references:
  - .pipeline/profiles.yaml
  - .pipeline/pipeline.yaml
  - src/pipeline-init.ts
  - src/schedule-planner.ts
  - src/workflow-planner.ts
  - src/pipeline-runtime.ts
priority: high
ordinal: 88000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make `PIPE-41` the scheduling epic. Phase 1 keeps the baseline/profile hardening work in `PIPE-41.1` through `PIPE-41.5`: profile skill wiring, prompt hardening, full pipe baseline, full epic baseline, and regression coverage. Phase 2 replaces the old node-level skill override direction with constrained agent-generated DAG scheduling for `$epic`.

When `$epic PIPE-41` runs, the scheduler should extract the epic id, load its Backlog child tickets as canonical work units, ask the configured schedule planner to assign each child to existing profiles/workflows, emit a validated `kind: pipeline-schedule` DAG with embedded workflows and per-node `task_context`, write `.pipeline/runs/<runId>/schedule.yaml`, and stop for approval before execution.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 `PIPE-41.1` through `PIPE-41.5` keep the profile/prompt/baseline regression hardening phase intact
- [x] #2 Schedule policies use their `baseline` only as the planner seed; there is no separate baseline-refinement strategy
- [x] #3 Scheduled epics resolve Backlog child tickets before prompt decomposition and pass those work units to the planner
- [x] #4 Agent-generated schedules use only configured profiles/workflows, embed every workflow reference, and assign one implementation branch per backlog child ticket with `task_context`
- [x] #5 Generated schedules reject cycles, missing embedded workflow references, invalid profile/workflow ids, missing assigned units, and implementation branches without downstream verification/review
- [x] #6 `pipe run --entrypoint epic PIPE-41` writes `.pipeline/runs/<runId>/schedule.yaml` and stops for approval before any workflow node executes
- [x] #7 `PIPE-41.12` resolves the installed-pipe dogfood gap: generated epic schedules are ticket-accurate for multi-child epics such as PC-37 and validate with the installed `pipe validate --schedule` command.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Complete the baseline/profile hardening tickets first (`PIPE-41.1` through `PIPE-41.5`). Then implement the constrained agent graph scheduling sequence:

1. `PIPE-41.6` documents the scheduler contract and why node-level skill overrides are deferred.
2. `PIPE-41.7` propagates node-level task context through schema, planning, runtime prompts, and nested workflows.
3. `PIPE-41.8` resolves Backlog child tickets for scheduled epics.
4. `PIPE-41.9` implements constrained agent-graph schedule planning with allowed primitives and work units.
5. `PIPE-41.10` validates generated schedule policy coverage.
6. `PIPE-41.11` updates operator docs, generated defaults, and regression coverage for dynamic epic scheduling.

Backlog grooming update on 2026-06-04: `PIPE-41.1` through `PIPE-41.11` are complete and verified. Keep the epic open for `PIPE-41.12`, which tracks the newer PC-37 dogfood failure where installed-pipe validation and generated epic schedule shape drifted.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Fresh grooming verification passed `bun run typecheck`, `bun run check`, `bun run build`, `bun run test` (24 test files, 331 tests), `bun run test:dogfood` (4 tests), `bun src/index.ts validate --schedule .pipeline/runs/run-20260603204455/schedule.yaml`, `bun src/index.ts explain-plan --schedule .pipeline/runs/run-20260603204455/schedule.yaml`, `bun src/index.ts validate --schedule .pipeline/runs/run-20260603204951/schedule.yaml`, and `bun src/index.ts explain-plan --schedule .pipeline/runs/run-20260603204951/schedule.yaml`. The parent remains open because `PIPE-41.12` covers a later installed-pipe dogfood issue not fully proven by those older generated artifacts.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Completed the agent-driven workflow scheduling epic including the installed-pipe dogfood follow-up. The final `PIPE-41.12` slice made epic schedules ticket-accurate for multi-child Backlog epics, preserved Backlog dependency edges, kept `task_context` valid across source and installed CLI paths, and added PC-37-shaped dogfood coverage. Fresh verification on 2026-06-04 passed typecheck, check, build, full tests, dogfood, and built CLI validate/explain schedule commands.

<!-- SECTION:FINAL_SUMMARY:END -->
