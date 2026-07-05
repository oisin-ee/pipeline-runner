---
id: PIPE-41.12.3
title: >-
  Align task_context schema support across source, generated defaults, and
  installed CLI
status: Done
assignee: []
created_date: "2026-06-04 09:27"
updated_date: "2026-06-04 09:48"
labels:
  - pipeline
  - schedules
  - schema
  - installed-pipe
dependencies:
  - PIPE-41.12.1
references:
  - src/config.ts
  - src/schedule-planner.ts
  - src/workflow-planner.ts
  - src/pipeline-init.ts
  - .pipeline/prompts/schedule-planner.md
  - tests/config.test.ts
  - tests/cli.test.ts
  - tests/package-public-api.test.ts
modified_files:
  - src/config.ts
  - src/schedule-planner.ts
  - src/workflow-planner.ts
  - src/pipeline-init.ts
  - .pipeline/prompts/schedule-planner.md
  - tests/config.test.ts
  - tests/cli.test.ts
  - tests/package-public-api.test.ts
parent_task_id: PIPE-41.12
priority: high
ordinal: 108000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Eliminate the installed-pipe drift where a generated schedule containing `task_context` is valid in local source expectations but rejected by the user-facing `pipe validate --schedule` path. This ticket owns compatibility of the schedule artifact schema, workflow-node schema, generated defaults, public package export behavior, and CLI validation path.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 A schedule artifact containing node `task_context.id` plus hydrated title, description, and acceptance criteria parses and compiles through the same config/workflow schema used by `pipe validate --schedule`.
- [x] #2 The generated `pipe init` defaults and checked-in schedule planner prompt agree that planners output only `task_context.id` and the scheduler hydrates all other fields from Backlog.
- [x] #3 The public `@oisincoveney/pipeline/schedule` export accepts and compiles a schedule artifact with `task_context` from a separate consumer project after build.
- [x] #4 A CLI-level test validates and explains an approved schedule artifact containing `task_context` without reporting `Unrecognized key: task_context`.
- [x] #5 The implementation removes schema drift at the source of truth; it does not strip `task_context` from schedules as a compatibility workaround.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Trace the `pipe validate --schedule` path in `src/index.ts` through `parseScheduleArtifact`, `compileScheduleArtifact`, `validatePipelineConfig`, and `compileWorkflowPlan` to identify the schema that rejects `task_context`.
2. Add focused tests in `tests/config.test.ts`, `tests/cli.test.ts`, and `tests/package-public-api.test.ts` that use an approved schedule artifact containing hydrated `task_context`.
3. Align the source schema and generated defaults so `task_context` is valid everywhere schedules are parsed, compiled, validated, explained, and consumed by public package imports.
4. Keep planner-output guidance consistent: planner emits only ids, scheduler hydrates canonical context. Do not solve installed compatibility by deleting task context from generated artifacts.
5. Run `bun test tests/config.test.ts tests/cli.test.ts tests/package-public-api.test.ts`, `bun run build`, and a built or installed `pipe validate --schedule` smoke before completion.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Execution started after schedule dependency validation was green. This slice adds regression coverage for `task_context` through config/schema, CLI validate/explain, and public package import paths, with source changes only if the tests expose drift.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

`task_context` support is locked across config/schema, schedule parsing/compilation, CLI validate/explain, generated prompt/default guidance, and the public `@oisincoveney/pipeline/schedule` export. The fix preserves hydrated task context rather than stripping it for compatibility. Verification included `bun run test tests/config.test.ts tests/cli.test.ts tests/package-public-api.test.ts`, full tests, typecheck, check, build, and built CLI schedule validation.

<!-- SECTION:FINAL_SUMMARY:END -->
