---
id: PIPE-31.6
title: 'CLI: pipe validate lint extensions + --strict flag'
status: Done
assignee: []
created_date: '2026-05-28 17:44'
updated_date: '2026-05-28 20:53'
labels:
  - drain
  - cli
milestone: m-0
dependencies:
  - PIPE-31.5
references:
  - /Users/oisin/.claude/plans/right-now-we-have-parallel-abelson.md
  - 'src/index.ts:315'
modified_files:
  - src/config.ts
  - src/index.ts
  - tests/cli.test.ts
parent_task_id: PIPE-31
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Extend `pipe validate` (already runs schema validation and compiles the workflow plan) with a small set of additional lints. Add a `--strict` flag that turns warnings into errors.

## Why

The structural-DAG primitives (`kind: workflow`, `kind: parallel`) and the entrypoint-as-subcommand feature introduce new failure modes that aren't caught by the JSON schema alone — they're cross-reference/style issues. Catching them in `pipe validate` makes the CLI useful as a CI gate (`pipe validate --strict`) and a friendly local check.

## Lints to add

All print as **warnings** unless `--strict` is passed.

1. **Entrypoint shadowed by a builtin subcommand.** Entrypoint id is in the `DIRECT_SUBCOMMANDS` set (`run`, `validate`, `doctor`, `init`, `install-commands`, `explain-plan`). Message: `entrypoint '<id>' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint <id> ...'`.
2. **Missing file references.** Any `skill.path`, `instructions.path`, or `output.schema_path` in `profiles.yaml` that doesn't exist on disk. Resolve relative to the worktree root. Message: `<profile>.<field> references missing file '<path>'`.
3. **Undefined workflow ids.** Any `kind: workflow` node whose `workflow:` value isn't a key in `config.workflows`. (Schema may already enforce this — verify; if so, this lint is a defense in depth and can be elided.) Message: `node '<id>' references undefined workflow '<workflowId>'`.
4. **Empty parallel container.** Any `kind: parallel` node with zero or one child. Schema rejects zero; this lint adds the one-child case (a one-child parallel is just a wrapper — likely a mistake). Message: `node '<id>' is a parallel container with only one child; remove the wrapper`.
5. **Soft worktree_root style nudge.** `worktree_root` values that don't sit under a sensible root (`.pipeline/runs/`, `.pipeline/drain/`). Message: `node '<id>' worktree_root '<path>' is outside the suggested .pipeline/runs/ root; this is a style nudge, not an error`.

## CLI surface (src/index.ts)

The existing `validate` subcommand (lines ~315-331) gets two new options:

```ts
.option("--strict", "treat lint warnings as errors")
.option("--no-lint", "skip lint pass (schema-only)")
```

Action flow:
1. Load config (existing).
2. Run schema validation + `compileWorkflowPlan` (existing).
3. Unless `--no-lint`: run the lint set above against the loaded config. Emit warnings via stderr with a `WARN ` prefix.
4. If `--strict` and any warnings were emitted: exit non-zero.

The schema/compile errors continue to exit non-zero unconditionally.

## Output format

For machine consumption (and future hooks/CI), structure each lint as `WARN <rule-id>: <message> (<file>:<line> if available)`. Rule ids: `entrypoint-shadowed`, `missing-file-reference`, `undefined-workflow`, `singleton-parallel`, `worktree-root-style`.

## Tests (tests/cli.test.ts)

1. `pipe validate emits entrypoint-shadowed warning when an entrypoint collides with a builtin`.
2. `pipe validate emits missing-file-reference warning when a profile points at a non-existent prompt`.
3. `pipe validate emits singleton-parallel warning for a parallel container with one child`.
4. `pipe validate emits worktree-root-style warning for an unusual worktree_root`.
5. `pipe validate --strict exits non-zero when any warning is emitted`.
6. `pipe validate --no-lint skips lints (schema-only)`.
7. `pipe validate exits non-zero on schema error regardless of --strict`.

## Dependencies

Depends on PIPE-31.5 (entrypoint-as-subcommand) — the entrypoint-shadowing lint targets that surface. Other lints are independent and could land earlier, but bundling them keeps the validate UX coherent.

## Reference

`/Users/oisin/.claude/plans/right-now-we-have-parallel-abelson.md` §"Linting via existing `pipe validate`".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `pipe validate` runs the existing schema+plan checks then a new lint pass; lints emit `WARN <rule-id>: <message>` to stderr
- [x] #2 `--strict` flag turns any warning into a non-zero exit
- [x] #3 `--no-lint` flag skips the lint pass (schema-only behavior preserved)
- [x] #4 Lint: entrypoint-shadowed — fires when entrypoint id collides with a builtin subcommand
- [x] #5 Lint: missing-file-reference — fires when `skill.path`, `instructions.path`, or `output.schema_path` references a file not on disk
- [x] #6 Lint: undefined-workflow — fires when a `kind: workflow` node points at an unknown workflow id (or is verified to be redundant with schema)
- [x] #7 Lint: singleton-parallel — fires when a `kind: parallel` container has exactly one child
- [x] #8 Lint: worktree-root-style — fires when `worktree_root` is outside `.pipeline/runs/` or `.pipeline/drain/`
- [x] #9 Schema validation errors continue to exit non-zero regardless of `--strict`/`--no-lint`
- [x] #10 Tests cover each lint rule, --strict promotion, --no-lint skip, and schema-error precedence
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented `pipe validate` lint extensions and strict/no-lint controls through the configured pipe workflow. Validate now runs schema/config/plan checks first, then emits `WARN <rule-id>: <message>` lint warnings for entrypoint shadowing, missing file references, singleton parallel containers, and worktree root style. `--strict` promotes warnings to failure, `--no-lint` preserves schema-only behavior, normal config loading remains strict, and undefined workflow references remain hard config validation. Verification passed: acceptance PASS, verifier PASS, typecheck, full tests, semgrep, and duplication.
<!-- SECTION:FINAL_SUMMARY:END -->
