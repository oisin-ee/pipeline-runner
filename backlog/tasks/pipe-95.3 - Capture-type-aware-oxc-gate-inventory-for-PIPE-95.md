---
id: PIPE-95.3
title: Capture type-aware oxc gate inventory for PIPE-95
status: Done
assignee: []
created_date: "2026-07-05 10:55"
updated_date: "2026-07-05 13:58"
labels:
  - migration
dependencies:
  - PIPE-95.2
references:
  - >-
    backlog/tasks/pipe-95 -
    Complete-Biome-oxc-strict-Effect-lint-migration-oisin-ee-oxlint-config.md
  - oxlint.config.ts
  - oxfmt.config.ts
modified_files:
  - package.json
  - oxlint.config.ts
  - oxfmt.config.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 348000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Lock the standard gate surface to type-aware Ultracite/Oxlint, keep strict + Effect config active, and capture the current failing diagnostic inventory that drives the remaining PIPE-95 child tickets. This ticket does not make the gate green.
Scope: package check script, oxlint/oxfmt config, and diagnostic inventory only. Do not edit source/test files except to undo accidental scope drift. Do not reintroduce Biome or add suppressions.
Dependencies / Blocked by: PIPE-95.2.
Likely modified files: package.json, oxlint.config.ts, oxfmt.config.ts.
Research required: node_modules/@oisin-ee/oxlint-config/README.md, node_modules/ultracite/config/oxfmt/index.mjs, ./node_modules/.bin/oxlint --help, ./node_modules/.bin/oxfmt --help, and fresh `nub run check` output.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-low -- current host metadata exposes gpt-5.5; this slice is config/inventory, not broad code migration.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer; defaults/pipeline.yaml routes implementation nodes through broker/gpt-5.5 fallbacks. Dispatch must revalidate live availability.
  Escalation:
- Met: type-aware gate surface is active and diagnostic inventory is recorded.
- Unmet: record exact config/script/load error, command output, and why the inventory cannot be trusted.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 The repo check script runs type-aware Ultracite/Oxlint by default. -- Evidence: jq -r '.scripts.check' package.json contains 'ultracite check --type-aware' and includes the standard migration surfaces.
- [x] #2 Strict + Effect config remains active under Oxlint. -- Evidence: ./node_modules/.bin/oxlint -c oxlint.config.ts --print-config | rg 'typeAware|typeCheck|typescript/consistent-type-assertions|effect/avoid-try-catch|effect/' exits 0.
- [x] #3 The failing gate inventory is fresh and grouped for follow-on tickets. -- Evidence: nub run check exits non-zero; saved output records total errors/warnings plus top rule clusters and top file/directory clusters.
- [x] #4 No Biome fallback exists. -- Evidence: rg -n '@biomejs/biome|ultracite/biome|biome-ignore' package.json lock.yaml renovate.json src tests exits 1.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

2026-07-05 proof:

- jq -r .scripts.check package.json printed: ultracite check --type-aware src tests package.json lock.yaml renovate.json oxlint.config.ts oxfmt.config.ts.
- ./node_modules/.bin/oxlint -c oxlint.config.ts --print-config | rg "typeAware|typeCheck|typescript/consistent-type-assertions|effect/avoid-try-catch|effect/" exited 0.
- rg -n "@biomejs/biome|ultracite/biome|biome-ignore" package.json lock.yaml renovate.json src tests exited 1; test ! -e biome.jsonc exited 0.
- nub run check exited 1 as expected for inventory; log saved at /tmp/pipe95-3-nub-check-20260705.log.
- Inventory totals: 13,661 errors, 1,736 warnings, 451 files with errors.
- Top rule clusters: func-style 2888; no-use-before-define 2495; effect(avoid-sync-fs) 631; effect(prefer-option-over-null) 627; strict-boolean-expressions 518; sort-keys 504; promise-function-async 451.
- Top file clusters: tests/cli.test.ts 505; src/runtime/opencode-session-executor.ts 216; src/run-state/git-refs.ts 208; src/runtime/node-execution.ts 207; src/runtime/events/events.ts 192.
- Top directory clusters: src/runtime 3676; src/run-control 765; src/cli 577; tests/cli.test.ts 505; src/loop 475.
- nub run typecheck exited 0; git diff --check exited 0; moka ticket graph check --root PIPE-95 exited 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Locked the type-aware oxc gate surface and captured the fresh failing inventory for follow-on PIPE-95 cleanup tickets. This ticket intentionally leaves nub run check red; later tickets own the cleanup.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 The ticket's global-rules workflow was run in order.
- [x] #2 Focused proof ran fresh and output was recorded.
- [x] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
