---
id: PIPE-31
title: 'Epic: drain — structural nested-DAG workflows'
status: Done
assignee: []
created_date: '2026-05-28 17:40'
updated_date: '2026-05-29 08:42'
labels:
  - drain
  - epic
milestone: m-0
dependencies: []
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
modified_files:
  - src/pipeline-runtime.ts
  - src/workflow-planner.ts
  - src/config.ts
  - src/index.ts
  - src/install-commands.ts
  - src/gates.ts
  - src/pipeline-init.ts
  - src/runner.ts
  - tests/pipeline-runtime.test.ts
  - tests/workflow-planner.test.ts
  - tests/config.test.ts
  - tests/cli.test.ts
  - tests/install-commands.test.ts
  - tests/gates.test.ts
  - tests/pipeline-init.test.ts
  - tests/runner.test.ts
  - .pipeline/pipeline.yaml
  - .pipeline/profiles.yaml
  - .pipeline/runners.yaml
  - .pipeline/prompts/orchestrator.md
  - .pipeline/prompts/epic-router.md
  - .pipeline/prompts/hardened-review.md
  - .pipeline/schemas/epic-plan.schema.json
  - .pipeline/schemas/review.schema.json
  - .gitignore
  - README.md
priority: high
ordinal: 100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal

Extend `oisin-pipeline` to support nested-DAG workflow shapes. A workflow's `nodes:` list becomes a mix of leaf nodes (`agent`/`command`/`builtin`) and sub-DAGs — either another named workflow invocation (`kind: workflow`) or a parallel container (`kind: parallel`). Parallel branches can run in isolated git worktrees so independent work proceeds concurrently without colliding on shared files. A `drain-merge` builtin reconciles the resulting per-branch git branches into an integration branch.

This unlocks two end-user shapes:

1. **Epic drain** — `pipe epic <id>` runs a workflow that researches → routes the epic's sub-tickets into named tracks (test/frontend/backend/k8s) → fans those tracks out in parallel, each in its own worktree running the existing `default` workflow (or a track-specific one) → merges all PASSed branches → runs a hardened-review skill against the integration branch.
2. **Composable future shapes** — any DAG shape that mixes serial and parallel sub-workflows.

## Why nested DAG, not dynamic fanout

An earlier proposal used a `fanout` node whose count and shape came from a prior node's JSON output. The user pushed back: that makes the DAG shape implicit, hides routing inside topology, and is unreadable. Nested-DAG composition keeps the shape auditable in YAML; agent routing decides which work goes to which fixed branch, never how many branches exist.

## Scope

- Two new runtime primitives: `kind: workflow` (invoke a named sub-workflow) and `kind: parallel` (children run concurrently). Both general-purpose.
- One new project builtin: `drain-merge` (topological merge of per-branch worktrees into an integration branch with conflict capture).
- CLI: configured entrypoints become first-class Commander subcommands visible in `pipe --help`. Backed by eager config load with propagated errors. `pipe validate` gains lints + `--strict`.
- `install-commands` generates one slash command per configured entrypoint across all hosts.
- Config: new `epic` entrypoint, `epic-drain` workflow, supporting profiles/schemas/prompts, and a `hardened-review` skill registration.

## Out of scope

- Any dynamic-shape (fanout-style) primitive. The number of parallel branches is fixed in YAML.
- Auto-resolving merge conflicts during integration. Conflicts are surfaced; user resolves.
- A separate `drain` entrypoint for a flat list of independent tickets (no epic). Can be added later as another workflow config built from the same primitives.

## End-to-end verification

1. `pnpm test` and `pnpm tsc --noEmit` clean.
2. `pipe validate --entrypoint epic` parses.
3. `pipe explain-plan --entrypoint epic` prints `research → plan → implement(parallel: test, frontend, backend, k8s) → merge → review`.
4. `pipe install-commands` produces `/epic` for every host alongside `/pipe`.
5. Live: an epic with sub-tickets across all four tracks produces four worktrees under `.pipeline/runs/<runId>/`, each runs its sub-workflow, drain-merge integrates PASSed branches, hardened-review emits a verdict.
6. Live: two tickets in different tracks both touching `package.json` cause drain-merge to surface the conflict in its report; worktrees + branches are kept for inspection.

## Reference

Source plan: `/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md`. Each subtask carries the slice of the plan it owns.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All 10 child tasks reach Done
- [x] #2 End-to-end verification 1–6 above all pass
- [x] #3 No regression in existing `pipe` / `default` workflow behavior — `pipe "<task>"` and `pipe inspect "<task>"` work unchanged
- [x] #4 README documents the `epic` entrypoint and the structural-parallelism primitives
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
All 10 child tasks are Done. Parent acceptance and verifier stages passed after final repair to preserve successful workflow worktrees when parallel workflow children feed `drain-merge`, while retaining standalone successful workflow-node cleanup. Deterministic verification passed: focused parent epic-drain/runtime tests, full test suite, typecheck, `validate --entrypoint epic`, `explain-plan --entrypoint epic`, `install-commands --host all --check`, Semgrep, and duplication. Learner recorded the durable drain-merge worktree-preservation lesson.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered structural nested-DAG workflow support for epic drain: `kind: workflow`, `kind: parallel`, isolated worktree execution, `drain-merge`, configured `epic` entrypoint, generated `/epic` and `$epic` command surfaces, router/reviewer assets, validation/install support, README documentation, and end-to-end runtime coverage for four-track success and package.json conflict inspection. Parent acceptance, verifier, and learner stages completed successfully.
<!-- SECTION:FINAL_SUMMARY:END -->
