---
id: PIPE-45.7
title: Split run-control command and store suppressions
status: Done
assignee: []
created_date: "2026-06-27 14:03"
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/run-control/commands.ts
  - src/run-control/store.ts
modified_files:
  - src/run-control/commands.ts
  - src/run-control/store.ts
  - src/run-control/command-context.ts
  - src/run-control/file-errors.ts
  - src/run-control/logical-segment.ts
  - src/run-control/resume-command.ts
  - src/run-control/run-artifacts-command.ts
  - src/run-control/run-command-domain.ts
  - src/run-control/run-query-command.ts
  - src/run-control/stop-command.ts
  - src/run-control/store-fs-effects.ts
  - src/run-control/store-manifest.ts
  - src/run-control/store-paths.ts
  - src/run-control/store-types.ts
  - tests/run-control-commands.test.ts
  - tests/run-control-file-store-helpers.ts
  - tests/run-control-refactor-boundaries.test.ts
  - tests/run-control-test-helpers.ts
  - tests/run-control-store.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 302000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: Split run-control CLI command concerns from store contracts/projections/writers and remove suppressions that hide ownership problems.
Dependencies: PIPE-45.1
Likely modified files: src/run-control/commands.ts, src/run-control/store.ts, src/run-control/_, tests/run-control-_.test.ts
Reuse: existing run-control store contracts and postgres/file implementations; no new persistence layer.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Run-control command parsing/output and store semantics have separate owners -- Evidence: source inspection: `src/run-control/commands.ts` is 133-line registration owner; command behaviour moved to `run-query-command.ts`, `run-artifacts-command.ts`, `stop-command.ts`, `resume-command.ts`, `command-context.ts`; filesystem store logic moved to `store-fs-effects.ts`, `store-manifest.ts`, `store-paths.ts`, `store-types.ts`, `logical-segment.ts`, `file-errors.ts`.
- [x] #2 Existing run-control tests pass without added suppressions -- Evidence: `bunx vitest run tests/run-control-refactor-boundaries.test.ts tests/run-control-commands.test.ts tests/run-control-store.test.ts tests/run-control-store-contract.test.ts tests/run-control-store-seam.test.ts tests/run-control-store-cutover.test.ts tests/next-node.test.ts tests/moka-resume.test.ts tests/run-control-runtime-reporter.test.ts tests/run-control-heartbeats.test.ts tests/detached-run.test.ts tests/supervised-run.test.ts` passed 53 tests, 12 skipped; `bun run check` passed; no `fallow-ignore-file` remains in `src/run-control/commands.ts` or `src/run-control/store.ts`.
- [x] #3 No broad fallbacks or silent error handling are introduced -- Evidence: quality-gate review plus `bun run typecheck`, `bun run check`, `pnpm exec fallow audit --changed-since HEAD --production`, `bun run build`, `bun run test` all exited 0; errors stay in Effect/CLI error channels and no new suppressions/casts were added.
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order and record proof. Proof: boundary test was observed RED on file-level suppressions before implementation; after split, focused run-control suite passed, `bun run typecheck` passed, `bun run check` passed, `pnpm exec fallow audit --changed-since HEAD --production` exited 0 with only inherited warnings excluded by the new-only gate, `bun run build` passed, and full `bun run test` passed 147 files / 1093 tests with 5 files / 41 tests skipped.
<!-- DOD:END -->
