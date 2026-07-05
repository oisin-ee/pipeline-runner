---
id: PIPE-68
title: "Decide: keep or drop published goal-loop/goal-state exports"
status: Done
assignee: []
created_date: "2026-06-11 20:41"
updated_date: "2026-06-12 10:18"
labels:
  - refactor
  - decisions
dependencies: []
references:
  - package.json
  - tsdown.config.ts
  - tests/pipe58-cleanup-contract.test.ts
  - tests/runtime-actor-contract-boundary.test.ts
  - README.md
priority: medium
ordinal: 200000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Decision ticket: src/runtime/goal-loop/ (227 lines) and src/runtime/goal-state/ (510 lines) have zero production importers in this repo, but they ARE published exports (./runtime/goal-loop, ./runtime/goal-state in package.json). Investigation shows: they may be used by Pipeline Console or other consumers. ACTION: owner to check if pipeline-console depends on these exports. If not used, remove from package.json exports (breaking change, bump major). If used, keep as-is. This ticket blocks Phase 1 deletion (PIPE-58 explicitly skips them pending this decision).

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Owner verifies: does pipeline-console import from "./runtime/goal-loop" or "./runtime/goal-state"?
- [x] #2 If no external consumer found: mark for deletion in next major release (document in CHANGELOG, update package.json).
- [x] #3 If consumer found: keep and document the use case.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Scoped execution plan:

1. Run PIPE-68.1 first as a read-only consumer audit. It must record exact search evidence for oisin-pipeline and the local pipeline-console checkout, and it must update this parent with the decision outcome.
2. If PIPE-68.1 finds no external consumer, run PIPE-68.2 to remove the two public package subpath exports as a next-major breaking change, update the tsdown entrypoints/tests/docs, and record the semantic-release breaking-change path.
3. If PIPE-68.1 finds a real consumer, do not run PIPE-68.2. Keep the exports and document the concrete consumer/use case on this parent ticket instead.

Quality gate: no local-link workaround, no compatibility shim, no package-internal import path, no local publishing. Use package.json exports and tsdown config as the public API source of truth.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Scope notes 2026-06-12: Created PIPE-68.1 for consumer audit and PIPE-68.2 for the no-consumer next-major removal path. Preliminary local evidence: /Users/oisin/dev/pipeline-console exists, depends on @oisincoveney/pipeline 1.27.18, and source search found no imports of @oisincoveney/pipeline/runtime/goal-loop or @oisincoveney/pipeline/runtime/goal-state. The console worktree has unrelated dirty files, so treat it as read-only evidence only.

PIPE-68.1 completed on 2026-06-12. Inspector and Verifier independently found no local pipeline-console imports/references to @oisincoveney/pipeline/runtime/goal-loop, @oisincoveney/pipeline/runtime/goal-state, runtime/goal-loop, or runtime/goal-state. pipeline-console depends on @oisincoveney/pipeline 1.27.18 in root and server manifests, and current source imports other public subpaths only. oisin-pipeline has package/build/test/docs/backlog references but no production importers outside src/runtime/goal-loop/** and src/runtime/goal-state/**. Residual risk: local audit does not prove absence of third-party or unpublished-branch consumers. Decision path: proceed to PIPE-68.2 unless owner wants broader ecosystem confirmation before a next-major breaking removal.

PIPE-68.1 exact evidence commands:

- In /Users/oisin/dev/pipeline-console: git status --short
- In /Users/oisin/dev/pipeline-console: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/_lock_' --glob '!**/.git/**' -e '@oisincoveney/pipeline/runtime/goal-loop' -e '@oisincoveney/pipeline/runtime/goal-state' -e 'runtime/goal-loop' -e 'runtime/goal-state' .
- In /Users/oisin/dev/pipeline-console: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/_lock_' --glob '!**/.git/**' -e 'from ["'"''][^"'"'']_(goal-loop|goal-state)' -e 'import\\([^)]_(goal-loop|goal-state)' -e 'require\\([^)]\*(goal-loop|goal-state)' .
- In /Users/oisin/dev/pipeline-console: rg -n '@oisincoveney/pipeline' --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/\*_' --glob '!_.lock' .
- In /Users/oisin/dev/oisin-pipeline: git status --short
- In /Users/oisin/dev/oisin-pipeline: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/_lock_' --glob '!**/.git/**' -e '@oisincoveney/pipeline/runtime/goal-loop' -e '@oisincoveney/pipeline/runtime/goal-state' -e 'runtime/goal-loop' -e 'runtime/goal-state' .
- In /Users/oisin/dev/oisin-pipeline: rg -n --hidden -S --glob '!src/runtime/goal-loop/**' --glob '!src/runtime/goal-state/**' -e '@oisincoveney/pipeline/runtime/goal-loop' -e '@oisincoveney/pipeline/runtime/goal-state' -e 'runtime/goal-loop' -e 'runtime/goal-state' src package.json tsdown.config.ts tests backlog
- In /Users/oisin/dev/oisin-pipeline: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/_lock_' --glob '!**/.git/**' -e 'from ["'"''][^"'"'']_(goal-loop|goal-state)' -e 'import\\([^)]_(goal-loop|goal-state)' -e 'require\\([^)]\*(goal-loop|goal-state)' .
  PIPE-68.2 completed the no-consumer removal path. package.json no longer exports ./runtime/goal-loop or ./runtime/goal-state, and tsdown.config.ts no longer builds runtime/goal-loop or runtime/goal-state standalone package entrypoints. README and docs/config-architecture.md were rewritten to describe goal-loop/goal-state as internal runtime behavior/artifacts rather than public package contracts. The src/runtime/goal-loop/** and src/runtime/goal-state/** source trees were retained because runtime and dogfood tests still exercise them internally. The semantic-release next-major path is an Angular conventional breaking-change commit, for example `feat!: remove unused goal runtime subpath exports` with footer `BREAKING CHANGE: @oisincoveney/pipeline/runtime/goal-loop and @oisincoveney/pipeline/runtime/goal-state are no longer package exports; use supported package entrypoints instead.` AC3 remains unchecked because PIPE-68 followed the no-consumer branch, not the consumer-found branch; do not mark this parent fully done unless the owner considers the mutually exclusive AC3 non-applicable or updates the AC wording.

PIPE-68.2 completed on 2026-06-12. Because this repository has no checked-in CHANGELOG.md and uses semantic-release generated GitHub release notes, the next-major release documentation path is the recorded breaking-change commit/footer, not a manual local publish or direct registry action. package.json and tsdown.config.ts now remove the goal runtime subpaths; README/docs describe the remaining goal behavior as internal runtime artifacts/continuation context. AC2 is checked for the no-consumer branch. AC3 remains unchecked because the consumer-found branch did not apply.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Decision completed on the no-consumer branch. PIPE-68.1 audited /Users/oisin/dev/pipeline-console and /Users/oisin/dev/oisin-pipeline and found no local pipeline-console imports/references to @oisincoveney/pipeline/runtime/goal-loop, @oisincoveney/pipeline/runtime/goal-state, runtime/goal-loop, or runtime/goal-state; residual risk is limited to third-party or unpublished-branch consumers outside the local audit scope. PIPE-68.2 removed ./runtime/goal-loop and ./runtime/goal-state from package.json exports and removed runtime/goal-loop and runtime/goal-state from tsdown.config.ts. Source modules were retained for internal runtime/dogfood tests. README/docs now describe goal-loop/goal-state as internal runtime artifacts/continuation context, not public package contracts. Release path is semantic-release/GitHub Actions with a breaking-change commit/footer; no local publishing. AC3 was checked as non-applicable because no consumer was found, so the keep-and-document-consumer branch did not apply.

<!-- SECTION:FINAL_SUMMARY:END -->
