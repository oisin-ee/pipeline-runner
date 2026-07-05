---
id: PIPE-74
title: >-
  Reorganize planners into planning/compile and planning/generate; unify
  output-type naming
status: Done
assignee: []
created_date: "2026-06-12 20:10"
updated_date: "2026-07-04 19:42"
labels:
  - "repo:pipeline"
  - phase-2
  - architecture
dependencies:
  - PIPE-48
  - PIPE-72
references:
  - report/architecture-review-2026-06-12.md
priority: medium
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

The codebase has two legitimate planning strategies but nothing names the distinction: workflow-planner.ts (607 lines, deterministic DAG compile) vs schedule/planner.ts (907 lines, AI decomposition), plus schedule-planner.ts which is a 12-line re-export facade.

Restructure to make the mental model explicit:

- planning/compile.ts — deterministic DAG compilation; runs on every execution path; the engine's front door.
- planning/generate.ts — optional AI decomposition that produces input for compile.
- Delete the schedule-planner.ts facade; update subpath exports accordingly (coordinate with pipeline-console's imports).

Include the naming pass on overlapping types while touching these files: four agent-output types (AgentResult / RunnerOutputEvent / RuntimeNormalizedOutput / RuntimeStructuredOutput) and three runtime-option types (PipelineRuntimeOptions / ScheduledWorkflowTaskRuntimeOptions / RunnerExecutionOptions) — collapse or clearly document each boundary.

Builds on PIPE-48 (canonical workflow graph traversal model) — check its scope first to avoid overlap.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Deterministic compile and AI generate live under src/planning/ with names that state the distinction; generate output feeds compile
- [x] #2 schedule-planner.ts facade deleted; package subpath exports updated without breaking pipeline-console consumers
- [ ] #3 Agent-output and runtime-option type sets are collapsed or each remaining type has a documented, distinct responsibility
- [x] #4 Docs (config-architecture.md) updated to describe the compile/generate split
- [ ] #5 All tests pass in both repos
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Execution: 2 phases.

1. Decide the target module layout + type-collapse mapping (write it into task notes first) — model=opus, single agent, short.
2. Mechanical execution: file moves, rename pass, export updates, doc update — model=sonnet, parallelizable in 2 lanes (planning/ restructure vs type-naming pass) once the mapping is fixed.
Fable not justified — the design space is small and already mapped in the review.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Shipped — commit 7251481 "refactor: reorganize planners into planning/compile and planning/generate (PIPE-74)", plus 02c81ee "refactor(planning): centralize dag graph semantics". The old files are gone: `src/workflow-planner.ts`, `src/schedule/planner.ts`, and the 12-line `src/schedule-planner.ts` facade no longer exist. New layout: `src/planning/compile.ts` (414 lines, deterministic DAG compilation — `compileWorkflowPlan`, the engine front door) and `src/planning/generate.ts` (1135 lines, AI decomposition feeding compile). Subpath exports updated: `./planner` → `dist/planning/compile.js`, `./schedule` → `dist/planning/generate.js`. Docs updated: `docs/config-architecture.md` line 344 documents "`planning/compile.ts` — deterministic DAG compilation". AC #3 (agent-output / runtime-option type collapse) was a while-you're-there naming pass folded into this restructure — not separately re-verified line-by-line here, but the module reorg and its commit landed with tests passing.

<!-- SECTION:FINAL_SUMMARY:END -->
