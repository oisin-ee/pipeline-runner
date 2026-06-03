---
id: PIPE-41
title: Agent-driven workflow scheduling
status: To Do
assignee: []
created_date: '2026-06-03 18:24'
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
- [ ] #1 `PIPE-41.1` through `PIPE-41.5` keep the profile/prompt/baseline regression hardening phase intact
- [ ] #2 Schedule policies use their `baseline` only as the planner seed; there is no separate baseline-refinement strategy
- [ ] #3 Scheduled epics resolve Backlog child tickets before prompt decomposition and pass those work units to the planner
- [ ] #4 Agent-generated schedules use only configured profiles/workflows, embed every workflow reference, and assign one implementation branch per backlog child ticket with `task_context`
- [ ] #5 Generated schedules reject cycles, missing embedded workflow references, invalid profile/workflow ids, missing assigned units, and implementation branches without downstream verification/review
- [ ] #6 `pipe run --entrypoint epic PIPE-41` writes `.pipeline/runs/<runId>/schedule.yaml` and stops for approval before any workflow node executes
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
<!-- SECTION:PLAN:END -->
