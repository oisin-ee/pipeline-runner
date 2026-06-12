---
id: PIPE-68.2
title: Stage next-major removal of unused goal-loop and goal-state exports
status: Done
assignee: []
created_date: '2026-06-12 09:47'
updated_date: '2026-06-12 10:13'
labels:
  - refactor
  - public-api
  - release
dependencies:
  - PIPE-68.1
references:
  - package.json
  - tsdown.config.ts
  - tests/pipe58-cleanup-contract.test.ts
  - tests/runtime-actor-contract-boundary.test.ts
  - README.md
parent_task_id: PIPE-68
priority: medium
ordinal: 209000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
If PIPE-68.1 records no external consumer for @oisincoveney/pipeline/runtime/goal-loop or @oisincoveney/pipeline/runtime/goal-state, stage the package-surface removal as a next-major breaking change. This ticket owns the code/test/docs changes for the no-consumer branch. If PIPE-68.1 finds a real consumer, do not execute this ticket; instead keep the exports and document the consumer use case on PIPE-68.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 package.json no longer exports ./runtime/goal-loop or ./runtime/goal-state when PIPE-68.1 records no external consumer.
- [x] #2 tsdown.config.ts no longer builds runtime/goal-loop or runtime/goal-state entrypoints when the exports are removed.
- [x] #3 Tests that pin the package export set are updated to expect the removed subpaths, and a regression assertion covers the new public export surface.
- [x] #4 Release documentation is explicit: either a checked-in CHANGELOG.md entry is added, or the task final summary records that this repo uses semantic-release generated GitHub release notes and names the breaking-change commit/footer that will produce the next major release.
- [x] #5 README/docs references to goal-loop/goal-state as public package contracts are removed or rewritten as internal/runtime artifact documentation, without promising unsupported subpaths.
- [x] #6 PIPE-68 parent ACs are updated with the audit result and no-consumer removal evidence.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement only after PIPE-68.1 records no external consumer. Remove the two package subpath exports from package.json and remove their tsdown entrypoints. Keep source files only if still used internally by tests/docs/runtime; delete source only if the import graph proves they are fully dead and focused tests cover the deletion. Update tests/pipe58-cleanup-contract.test.ts and tests/runtime-actor-contract-boundary.test.ts to pin the new export surface. Search README/docs for goal-loop/goal-state wording and update only public-API claims. Follow AGENTS.md publishing standard: do not publish locally; use a breaking-change commit/release workflow path for the next major release.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the unsupported goal runtime subpaths from the next public package surface: package.json no longer exports ./runtime/goal-loop or ./runtime/goal-state, and tsdown.config.ts no longer emits standalone runtime/goal-loop or runtime/goal-state entrypoints. The source trees under src/runtime/goal-loop and src/runtime/goal-state were retained because focused runtime and dogfood tests still import and exercise them internally. README/docs wording now describes goal-loop/goal-state behavior as internal runtime artifacts/continuation context rather than public package contracts. Release path: this repository has no checked-in CHANGELOG.md and uses semantic-release generated GitHub release notes, so the removal should be committed with an Angular conventional breaking-change marker such as `feat!: remove unused goal runtime subpath exports` plus footer `BREAKING CHANGE: @oisincoveney/pipeline/runtime/goal-loop and @oisincoveney/pipeline/runtime/goal-state are no longer package exports; use supported package entrypoints instead.` Verification passed: `bunx vitest run tests/pipe58-cleanup-contract.test.ts tests/runtime-actor-contract-boundary.test.ts` passed with 2 files and 13 tests; `bunx vitest run src/runtime/goal-loop/goal-loop.test.ts src/runtime/goal-state/goal-state.test.ts tests/dogfood-installed.test.ts` passed with 3 files and 24 tests; `bun run typecheck` passed; `bun run check` passed with 177 files checked and no fixes applied; `bun run test` passed with 61 files passed, 1 skipped, 516 tests passed, 4 skipped; `bun run build` passed with tsdown build complete. Diff inspection showed only PIPE-68 package-surface, docs, tests, and backlog files changed.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused tests covering package exports pass.
- [x] #2 bun run typecheck passes.
- [x] #3 bun run check passes.
- [x] #4 bun run test passes or the final summary records a narrower focused run plus the reason full tests were deferred.
- [x] #5 git diff is inspected to confirm only PIPE-68 package-surface, docs, tests, and backlog files changed.
<!-- DOD:END -->
