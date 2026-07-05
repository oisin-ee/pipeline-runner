---
id: PIPE-95.5
title: Stabilize post-autofix strict lint baseline for PIPE-95
status: Done
assignee: []
created_date: '2026-07-05 19:19'
updated_date: '2026-07-05 19:19'
labels:
  - migration
dependencies:
  - PIPE-95.4
references:
  - >-
    backlog/tasks/pipe-95.4 -
    Apply-mechanical-strict-style-oxc-fixes-for-PIPE-95.md
  - /tmp/pipe95-5-final-oxlint.json
  - /tmp/pipe95-6-scope-files.txt
  - /tmp/pipe95-7-final-scoped.json
  - /tmp/pipe95-8-scope-final.json
  - /tmp/pipe95-5-stabilized-inventory-after-fix.json
  - oxlint.config.ts
modified_files:
  - src
  - tests
  - backlog/tasks
parent_task_id: PIPE-95
priority: medium
ordinal: 350000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Preserve the useful post-PIPE-95.4 autofix work, repair any behaviour/typecheck regressions it introduced, and record a fresh residual lint inventory for the rule-family tickets that follow. This is the stabilizing checkpoint after the first broad worker attempt, not the final lint cleanup.
Scope: Only repairs required to make the current dirty post-autofix tree typecheck and keep focused tests green. Do not clear broad Effect rule families here unless the fix is needed for a concrete regression.
Dependencies / Blocked by: PIPE-95.4.
Likely modified files: files already touched by the PIPE-95.5 through PIPE-95.8 workers, especially tests/cli.test.ts, src/schedule/passes/models.ts, runtime/opencode test seams, run-control command output seams, and Backlog evidence.
Research required: inspect the four worker summaries and fresh failing commands; inspect schedule/passes/models.ts before fixing the command-node regression; inspect oxlint JSON output before writing residual inventory.
Model recommendation:
- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-medium -- current host exposes gpt-5.5; this is cross-slice regression repair plus inventory.
- OpenCode: moka-code-writer/default -- previous scope evidence names moka-code-writer in local profiles; dispatch must revalidate live availability.
Escalation:
- Met: typecheck and focused regression tests pass; residual lint inventory is fresh and split by next ticket.
- Unmet: record the failing command, exact file/line, and the rule-family ticket blocked by it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Current post-autofix tree typechecks. -- Evidence: `nub run typecheck` exited 0 (`tsc --noEmit`).
- [x] #2 Worker-introduced behavioural regressions are repaired. -- Evidence: `./node_modules/.bin/vitest run tests/cli.test.ts` passed 52/52 after fixing the schedule command-node passthrough regression; `nub run test` passed 157 files, 1211 tests, 51 skipped.
- [x] #3 Fresh residual lint inventory exists for the remaining migration. -- Evidence: `/tmp/pipe95-5-stabilized-inventory-after-fix.json` from `./node_modules/.bin/oxlint --format=json`; total diagnostics 7196; top clusters mapped to PIPE-95.6 through PIPE-95.14.
- [x] #4 No shortcut suppressions or type escapes are introduced while stabilizing. -- Evidence: `git diff --check` exited 0 and `git diff -U0 -- src tests | rg -n '^\+.*(as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround)'` exited 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Start from the current dirty post-worker tree, repair concrete type/test regressions first, run focused tests, generate a fresh residual JSON inventory, and update this ticket with the rule/file counts feeding the next tickets.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-07-05 completion proof:
- Root cause repaired: broad autofix changed `src/schedule/passes/models.ts` from pass-through for non-agent/parallel nodes to throwing `Not implemented yet: "command" case`. The correct catalog-model contract only mutates agent nodes and recurses parallel children; builtin, command, group, and future node kinds pass through unchanged.
- `./node_modules/.bin/oxfmt -c oxfmt.config.ts src/schedule/passes/models.ts` exited 0.
- `nub run typecheck` exited 0.
- `./node_modules/.bin/vitest run tests/cli.test.ts` exited 0: 52 tests passed.
- `nub run test` exited 0: 157 files passed, 6 skipped; 1211 tests passed, 51 skipped.
- `./node_modules/.bin/oxlint --format=json` saved `/tmp/pipe95-5-stabilized-inventory-after-fix.json`; command exits nonzero as expected for remaining PIPE-95 rule-family tickets.
- Fresh residual top clusters: total 7196; avoid-sync-fs 631; prefer-option-over-null 627; strict-boolean-expressions 506; avoid-process-env 381; avoid-native-object-helpers 372; avoid-untagged-errors 350; imperative-loops 307; avoid-direct-json 265; effect-run-in-body 239; consistent-type-assertions 222.
- Residual assignment: absence/boolean -> PIPE-95.6; file/path/temp IO -> PIPE-95.7; env/clock/console/process -> PIPE-95.8; tagged errors/error flow -> PIPE-95.9; JSON/schema -> PIPE-95.10; functional/promise/runtime-boundary residuals -> PIPE-95.11; test fixtures -> PIPE-95.12; fallow/precommit -> PIPE-95.13; final full gate -> PIPE-95.14.
- `git diff --check` exited 0.
- Added-line escape scan exited 1 as expected: `git diff -U0 -- src tests | rg -n '^\+.*(as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround)'`.
- `moka ticket complete PIPE-95.5 ... --json` refused all criteria because the current `complete` command uses the conservative Layer A judge, which refuses all criteria with evidence unless deterministic gates are wired. Evidence was recorded directly in this Backlog task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Stabilized the post-autofix tree, fixed the schedule command-node pass-through regression, proved typecheck and full tests green, and recorded the fresh residual lint inventory for the rule-family chain.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The ticket global-rules feature-implementation workflow was run in order.
- [x] #2 Focused proof ran fresh and output was recorded.
- [x] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
