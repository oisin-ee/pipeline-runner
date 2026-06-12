---
id: PIPE-68.1
title: Audit consumers of published goal-loop and goal-state exports
status: Done
assignee: []
created_date: '2026-06-12 09:46'
updated_date: '2026-06-12 09:58'
labels:
  - refactor
  - decisions
  - public-api
dependencies: []
references:
  - package.json
  - tsdown.config.ts
  - tests/pipe58-cleanup-contract.test.ts
  - tests/runtime-actor-contract-boundary.test.ts
parent_task_id: PIPE-68
priority: medium
ordinal: 208000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verify whether the published @oisincoveney/pipeline subpaths ./runtime/goal-loop and ./runtime/goal-state have external consumers before changing the package surface. Known local evidence before this ticket: the oisin-pipeline repo has tests/docs/package exports for these subpaths but no production importers; the local /Users/oisin/dev/pipeline-console checkout depends on @oisincoveney/pipeline 1.27.18 and current source search found no imports of @oisincoveney/pipeline/runtime/goal-loop or @oisincoveney/pipeline/runtime/goal-state. Treat pipeline-console as read-only because its worktree has unrelated local changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pipeline-console source is searched for @oisincoveney/pipeline/runtime/goal-loop, @oisincoveney/pipeline/runtime/goal-state, runtime/goal-loop, and runtime/goal-state imports, and the exact command/evidence is recorded on PIPE-68.
- [x] #2 oisin-pipeline source/tests/docs are searched so repo-local production usage, test-only usage, and package export/build entries are separately recorded.
- [x] #3 Decision outcome is recorded on PIPE-68: no external consumer found, or consumer found with file/import/use-case evidence.
- [x] #4 No source/package export changes are made in this audit ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use repository search, not manual guessing. In oisin-pipeline, search for runtime/goal-loop and runtime/goal-state and classify each hit as production, test, docs, build config, or backlog metadata. In pipeline-console, search source and package manifests for @oisincoveney/pipeline runtime goal subpaths. Do not edit pipeline-console. If a consumer is found, record the concrete import and hand off to the keep/document path; if none is found, hand off to the removal/deprecation ticket.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Read-only consumer audit completed. MoKa Inspector and MoKa Verifier independently searched the local /Users/oisin/dev/pipeline-console checkout and /Users/oisin/dev/oisin-pipeline. pipeline-console evidence: root package.json devDependency @oisincoveney/pipeline 1.27.18; server/package.json dependency @oisincoveney/pipeline 1.27.18; searches excluding node_modules/dist/coverage/lock files found no imports or references to @oisincoveney/pipeline/runtime/goal-loop, @oisincoveney/pipeline/runtime/goal-state, runtime/goal-loop, or runtime/goal-state. Existing console imports use public config, argo-submit, and moka-submit subpaths. oisin-pipeline evidence: package.json still exports ./runtime/goal-loop and ./runtime/goal-state; tsdown.config.ts builds both entrypoints; tests/docs/backlog metadata reference them; production import search found no importers outside src/runtime/goal-loop/** and src/runtime/goal-state/**. Decision recommendation: no external pipeline-console consumer found; proceed to PIPE-68.2 no-consumer next-major removal path if owner accepts residual risk that this local audit does not prove absence of third-party or unpublished-branch consumers. Verification: no source/package export changes were made; git status before/after verification was unchanged except existing backlog task edits; bun run typecheck and bun run check were not run because PIPE-68.1 was a read-only evidence audit with no code changes.

Exact evidence commands recorded after acceptance review:
- In /Users/oisin/dev/pipeline-console: git status --short
- In /Users/oisin/dev/pipeline-console: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/*lock*' --glob '!**/.git/**' -e '@oisincoveney/pipeline/runtime/goal-loop' -e '@oisincoveney/pipeline/runtime/goal-state' -e 'runtime/goal-loop' -e 'runtime/goal-state' .
- In /Users/oisin/dev/pipeline-console: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/*lock*' --glob '!**/.git/**' -e 'from ["'"''][^"'"'']*(goal-loop|goal-state)' -e 'import\\([^)]*(goal-loop|goal-state)' -e 'require\\([^)]*(goal-loop|goal-state)' .
- In /Users/oisin/dev/pipeline-console: rg -n '@oisincoveney/pipeline' --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!*.lock' .
- In /Users/oisin/dev/oisin-pipeline: git status --short
- In /Users/oisin/dev/oisin-pipeline: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/*lock*' --glob '!**/.git/**' -e '@oisincoveney/pipeline/runtime/goal-loop' -e '@oisincoveney/pipeline/runtime/goal-state' -e 'runtime/goal-loop' -e 'runtime/goal-state' .
- In /Users/oisin/dev/oisin-pipeline: rg -n --hidden -S --glob '!src/runtime/goal-loop/**' --glob '!src/runtime/goal-state/**' -e '@oisincoveney/pipeline/runtime/goal-loop' -e '@oisincoveney/pipeline/runtime/goal-state' -e 'runtime/goal-loop' -e 'runtime/goal-state' src package.json tsdown.config.ts tests backlog
- In /Users/oisin/dev/oisin-pipeline: rg -n --hidden -S --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/*lock*' --glob '!**/.git/**' -e 'from ["'"''][^"'"'']*(goal-loop|goal-state)' -e 'import\\([^)]*(goal-loop|goal-state)' -e 'require\\([^)]*(goal-loop|goal-state)' .
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused evidence commands are included in the task final summary.
- [x] #2 bun run typecheck and bun run check pass, or the ticket states why this read-only audit did not require code checks.
<!-- DOD:END -->
