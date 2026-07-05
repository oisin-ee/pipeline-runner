---
id: PIPE-43
title: Decompose the runtime orchestration boundary
status: Done
assignee: []
created_date: "2026-06-04 14:40"
updated_date: "2026-06-04 18:47"
labels:
  - tech-debt
  - maintainability
  - runtime
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/pipeline-runtime.ts
  - src/runtime-machines/workflow-machine.ts
  - src/runtime-machines/node-machine.ts
  - src/runtime-machines/gate-machine.ts
  - src/runtime-machines/hook-machine.ts
priority: high
ordinal: 110000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

The runtime implementation is structurally over-concentrated. `src/pipeline-runtime.ts` currently owns workflow orchestration, node attempts, retries, snapshots, parallel/workflow child execution, worktree lifecycle, prompt rendering, output repair, gates, hooks, JSON schema validation, and event emission. The XState runtime machines currently act mostly as lifecycle wrappers around closures back into this same file, which leaves two models of the runtime instead of one clear ownership boundary. Refactor toward smaller canonical runtime services without changing public runtime behavior.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Runtime behavior remains compatible with existing CLI and public `runPipelineFromConfig` usage.
- [x] #2 Runtime responsibilities are split into focused modules with clear ownership boundaries for node execution, gate evaluation, hook execution, worktree handling, output validation/repair, and event emission.
- [x] #3 The state-machine layer either owns lifecycle decisions directly through narrow injected services or is simplified so it no longer duplicates imperative lifecycle control.
- [x] #4 `src/pipeline-runtime.ts` is substantially reduced and no longer contains the full implementation for all runtime subsystems.
- [x] #5 Representative runtime tests and real repository usage paths pass after the refactor.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Split the monolithic runtime implementation into focused `src/runtime/[name]/[name].ts` modules with colocated tests and barrel exports for agent execution, builtins, changed-file snapshots, command execution, runtime context, contracts, drain-merge, event emission, gate evaluation, hook dispatch, JSON validation, parallel containers, and worktree handling. `src/pipeline-runtime.ts` now acts as the orchestration facade and is reduced to 992 lines. Source imports across the touched runtime surface are extensionless, and the build uses `tsdown` powered by Rolldown. Verification passed: `bun run check`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:dogfood`, and `bun src/index.ts validate`. `bun src/index.ts validate --strict` still fails on the existing `entrypoint-shadowed` warning for the configured `pipe` entrypoint.

<!-- SECTION:FINAL_SUMMARY:END -->
