---
id: PIPE-95.4
title: Apply mechanical strict-style oxc fixes for PIPE-95
status: Done
assignee: []
created_date: "2026-07-05 13:21"
updated_date: "2026-07-05 15:16"
labels:
  - migration
dependencies:
  - PIPE-95.3
references:
  - >-
    backlog/tasks/pipe-95.3 -
    Capture-type-aware-oxc-gate-inventory-for-PIPE-95.md
  - oxlint.config.ts
modified_files:
  - src
  - tests
  - tsdown.config.ts
  - tsconfig.json
parent_task_id: PIPE-95
priority: medium
ordinal: 349000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Reduce the largest mechanical strict-rule clusters before semantic Effect/type fixes: func-style, no-use-before-define, sort-keys, require-unicode-regexp, func-names, import type specifier style, text encoding case, switch-case braces, no-useless-undefined, array-type, and no-array-sort. Use maintained oxc/Ultracite autofix where safe, then small source-equivalent edits for remaining mechanical diagnostics.
Scope: mechanical syntax/style-only edits across src and tests. No behaviour changes, no new suppressions, no Effect service rewrites, no unsafe casts.
Dependencies / Blocked by: PIPE-95.3.
Likely modified files: src/**/\*.ts, tests/**/\*.ts.
Research required: run `nub run check` first; inspect `./node_modules/.bin/oxlint --help` for fix mode and the relevant rule docs/help before non-autofix edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-medium -- current host metadata exposes gpt-5.5; broad mechanical edit with low design ambiguity.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer; defaults/pipeline.yaml routes implementation nodes through broker/gpt-5.5 fallbacks. Dispatch must revalidate live availability.
  Escalation:
- Met: targeted mechanical clusters are gone or materially reduced with source-equivalent diffs.
- Unmet: record remaining rule counts, files, and why automated/mechanical fixes were unsafe.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Target mechanical rule clusters are cleared. -- Evidence: nub run check output or parsed log shows zero remaining errors for func-style, no-use-before-define, sort-keys, require-unicode-regexp, func-names, import consistent-type-specifier-style, text-encoding-identifier-case, switch-case-braces, no-useless-undefined, array-type, and no-array-sort. If any remain, report blocked with counts and files instead of checking this AC.
- [x] #2 Mechanical edits do not change runtime behaviour; evidence: git diff reviewed for declaration/order/style-only changes plus nub run typecheck exits 0.
- [x] #3 No shortcut suppressions or type escapes are introduced; evidence: git diff --check exits 0 and git diff -U0 -- src tests | rg -n "as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround" exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Run the failing gate, apply safe oxc/Ultracite fixes first, hand-fix only source-equivalent mechanical leftovers, then rerun focused cluster counts and typecheck.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

2026-07-05 partial proof:

- Ran ./node_modules/.bin/ultracite fix --type-aware src tests package.json lock.yaml renovate.json oxlint.config.ts oxfmt.config.ts; command exited 1 after applying safe fixes and reporting residual diagnostics.
- Ran ./node_modules/.bin/oxfmt -c oxfmt.config.ts src tests package.json lock.yaml renovate.json oxlint.config.ts oxfmt.config.ts; exited 0.
- Added tsconfig lib [ES2023, DOM] to support toSorted/toReversed emitted by unicorn/no-array-sort fixes under package Node >=22.13.0.
- Fixed autofix regressions from no-arg Effect.succeed/Promise.resolve/mockResolvedValue and catch variable shadowing; nub run typecheck now exits 0.
- git diff --check exits 0.
- New escape scan exits 1: git diff -U0 -- src tests | rg -n "^\+.\*(as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround)".
- Fresh check log /tmp/pipe95-4-after-type-fix.log exits 1 with 12,822 errors, 1,666 warnings, 443 files with errors.
- Target residual counts: func-style 2888; no-use-before-define 2495; sort-keys 59; require-unicode-regexp 304; func-names 263; consistent-type-specifier-style 0; text-encoding-identifier-case 4; switch-case-braces 0; no-useless-undefined 30; array-type 2; no-array-sort 0.
- PIPE-95.4 AC1 remains unmet. Next pass needs deliberate source-equivalent transform/reorder for func-style/no-use-before-define rather than further blanket autofix.

2026-07-05 later partial proof:

- Applied diagnostic-driven mechanical rewrites: top-level helper ordering, function declarations to const expressions, named anonymous Effect generator bodies, Unicode regexp flags, typed absent-value constants for unsafe no-arg autofix fallout, and small cycle breaks where typecheck/lint proved TDZ risk.
- Fresh proof passes: ./node_modules/.bin/oxfmt -c oxfmt.config.ts src tests package.json lock.yaml renovate.json oxlint.config.ts oxfmt.config.ts; nub run typecheck; git diff --check; git diff -U0 -- src tests | rg -n '^\+.\*(as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround)' exits 1.
- Fresh target residual counts from /tmp/pipe95-4-stop.json: func-style 0; no-use-before-define 23; sort-keys 16; require-unicode-regexp 0; func-names 0; consistent-type-specifier-style 0; text-encoding-identifier-case 0; switch-case-braces 0; no-useless-undefined 0; array-type 0; no-array-sort 0.
- PIPE-95.4 AC1 remains unmet. Remaining work is local order/cycle cleanup for no-use-before-define and key-order fixes for sort-keys.

2026-07-05 rescope proof:

- ./node_modules/.bin/oxfmt -c oxfmt.config.ts src tests package.json lock.yaml renovate.json oxlint.config.ts oxfmt.config.ts exited 0.
- nub run typecheck exited 0.
- ./node_modules/.bin/oxlint -c oxlint.config.ts --format=json src tests exited 1 and saved /tmp/pipe95-rescope-current.json.
- Target residual counts: func-style 0; no-use-before-define 14; sort-keys 16; require-unicode-regexp 0; func-names 0; consistent-type-specifier-style 0; text-encoding-identifier-case 0; switch-case-braces 0; no-useless-undefined 0; array-type 0; no-array-sort 0.
- no-use-before-define files: src/loop/controller-deps.ts 3; src/loop/controller.ts 3; src/runtime/node-execution.ts 2; src/runtime/opencode-session-executor.ts 1; src/schedule/passes/models.ts 1; src/run-control/run-artifacts-command.ts 1; src/run-control/run-query-command.ts 1; src/run-control/supervisor.ts 1; src/install-commands/planner.ts 1.
- sort-keys files: src/loop/controller.test.ts 3; src/argo-workflow.ts 2; one each in src/runtime/opencode-server.ts, src/config/load.ts, src/config/schema/mcp.ts, src/runner-command-contract.ts, src/moka-global-config.ts, src/moka-submit.ts, src/runtime/context/context.ts, src/runner-command/run.ts, tests/run-control-store-contract.test.ts, src/install-commands/opencode.ts, tests/argo-submit.test.ts.
- Rescope decision: keep PIPE-95.4 as the mechanical residue finisher, then split post-95.4 work by write boundary so dispatch can run source slices without one mega-ticket.

2026-07-05 completion proof:

- ./node_modules/.bin/oxfmt -c oxfmt.config.ts tsdown.config.ts src tests package.json lock.yaml renovate.json oxlint.config.ts exited 0.
- nub run typecheck exited 0.
- nub run test exited 0: 157 files passed, 6 skipped; 1211 tests passed, 51 skipped.
- ./node_modules/.bin/oxlint --format=json exited nonzero as expected for later PIPE-95 slices and saved /tmp/pipe95-4-after-tsdown.json.
- PIPE-95.4 target residual counts from /tmp/pipe95-4-after-tsdown.json: func-style 0; no-use-before-define 0; sort-keys 0; require-unicode-regexp 0; func-names 0; consistent-type-specifier-style 0; text-encoding-identifier-case 0; switch-case-braces 0; no-useless-undefined 0; array-type 0; no-array-sort 0.
- Full remaining lint diagnostics are outside PIPE-95.4 scope: total diagnostics 9163; top remaining clusters are arrow-body-style 1464, effect(avoid-sync-fs) 631, effect(prefer-option-over-null) 630, strict-boolean-expressions 518, avoid-process-env 381, avoid-native-object-helpers 374, avoid-untagged-errors 331, imperative-loops 307.
- git diff --check exited 0.
- Escape scan exited 1 as expected: git diff -U0 -- src tests | rg -n '^\+.\*(as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround)'.
- Biome absence scan exited 1 as expected: test ! -e biome.jsonc && rg -n '@biomejs/biome|ultracite/biome|biome-ignore' package.json lock.yaml renovate.json src tests tsdown.config.ts.
- Diff reviewed as mechanical declaration/order/style-only cleanup for PIPE-95.4 target rules; no Effect service rewrites or unsafe suppressions added.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Cleared all PIPE-95.4 target mechanical strict-style clusters with fresh oxfmt, typecheck, parsed oxlint target-count, diff-check, and escape-scan proof. Full lint remains red for later scoped PIPE-95 tickets.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 The ticket global-rules feature-implementation workflow was run in order.
- [x] #2 Focused proof ran fresh and output was recorded.
- [x] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
