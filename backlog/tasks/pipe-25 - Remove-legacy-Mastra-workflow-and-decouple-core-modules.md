---
id: PIPE-25
title: Remove legacy Mastra workflow and decouple core modules
status: Done
assignee: []
created_date: '2026-05-25 20:02'
updated_date: '2026-05-25 20:32'
labels:
  - architecture
  - runtime
  - decoupling
dependencies:
  - PIPE-20
  - PIPE-21
priority: high
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remove the old Mastra workflow implementation and make the config-driven YAML runtime the only pipeline execution path. This is an architecture cleanup, not a feature expansion: it removes framework coupling and renames generic modules that currently live under `src/mastra/` even though they are not Mastra-specific.

The pipeline program should control flow, node execution, gates, runtime events, cancellation, and public API surfaces. It should not carry a second hardcoded Mastra workflow with separate RED/GREEN/VERIFY semantics. Useful behavior from the old implementation should be reintroduced later as generic gates/contracts, not preserved as Mastra step code.

Scope:
- Delete old Mastra framework files: `src/mastra/index.ts`, `src/mastra/workflows/pipeline.ts`, and `src/mastra/steps/*`.
- Move generic modules out of the `mastra` namespace: `config`, `runner`, `gates`, `tickets`, and `structured-output` if still used.
- Update all source imports, tests, generated build outputs, and package export targets to the new module paths.
- Remove package dependencies and scripts that invoke Mastra.
- Delete or rewrite tests that only exercise the old Mastra workflow.

Non-goals:
- Do not remove support for configured skills, MCP servers, rules, hooks, tools, filesystem/network grants, or runner capabilities.
- Do not add semantic verdict gates, acceptance gates, task context resolvers, or RED/GREEN contracts in this task. Those are separate tasks.
- Do not hardcode any task system, test framework, or repository layout while doing the cleanup.

Expected module moves:
- `src/mastra/config.ts` -> `src/config.ts`
- `src/mastra/runner.ts` -> `src/runner.ts`
- `src/mastra/gates.ts` -> `src/gates.ts`
- `src/mastra/tickets.ts` -> `src/task-ref.ts`
- `src/mastra/structured-output.ts` -> `src/structured-output.ts`, only if still needed after deleting old steps

Package exports must remain stable for consumers:
- `@oisincoveney/pipeline/config`
- `@oisincoveney/pipeline/runner`
- `@oisincoveney/pipeline/planner`
- `@oisincoveney/pipeline/runtime`

Before implementation, clean up any unrelated local prompt/config edits so this task starts from a deliberate baseline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 No source imports from @mastra/core remain.
- [x] #2 No package dependency on @mastra/core or mastra remains.
- [x] #3 Old Mastra workflow and step files are removed.
- [x] #4 Generic modules are no longer under src/mastra.
- [x] #5 YAML runtime is the only pipeline execution path.
- [x] #6 Public package subpaths remain stable while internal dist targets move away from dist/mastra.
- [x] #7 Tests no longer mock @mastra/core/workflows or src/mastra/index.
- [x] #8 Build scripts no longer call mastra dev/build/start.
- [x] #9 Any retained old behavior is covered through YAML runtime tests, not Mastra workflow tests.
- [x] #10 bunx vitest run, bun run typecheck, bun run check, and bun run build:cli pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory imports from `src/mastra/**` and split them into framework-specific code versus generic pipeline code.
2. Delete the Mastra-only workflow and step files.
3. Move generic modules to top-level `src/` names and update imports in runtime, CLI, init, installer, planner, and tests.
4. Update `package.json` exports and `build:cli` to emit the new top-level module paths while preserving public subpath names.
5. Remove `@mastra/core`, `mastra`, and Mastra scripts from `package.json`.
6. Remove old tests that only validate `createWorkflow`/`createStep` behavior; port any still-relevant behavior to YAML runtime tests only if it belongs to current runtime behavior.
7. Update README/docs references that imply Mastra is part of runtime execution.
8. Run full verification and fix path/type/build issues.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the legacy Mastra workflow path, moved generic modules to top-level source files, removed Mastra package/scripts/dependencies, preserved public exports at top-level dist targets, deleted old workflow tests, and verified with typecheck, check, tests, build, and dogfood.
<!-- SECTION:FINAL_SUMMARY:END -->
