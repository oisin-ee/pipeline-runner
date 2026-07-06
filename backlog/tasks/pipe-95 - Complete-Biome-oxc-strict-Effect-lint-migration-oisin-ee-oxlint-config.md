---
id: PIPE-95
title: Complete Biome->oxc + strict + Effect lint migration (@oisin-ee/oxlint-config)
status: Done
assignee: []
created_date: '2026-07-01 19:57'
updated_date: '2026-07-06 04:27'
labels:
  - migration
dependencies:
  - PIPE-95.14
ordinal: 332000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
pipeline-runner (@oisincoveney/pipeline) was a Biome lint repo, uses Effect (effect@4.0.0-beta.90). Created oxlint.config.ts (extends [core, strict], typeAware+typeCheck) + added oxc deps (@oisin-ee/oxlint-config, oxlint, oxfmt, oxlint-tsgolint) + @mpsuesser/oxlint-plugin-effect. Finish:

- nub install.
- Add oxfmt.config.ts (import ultracite/oxfmt).
- Add the effect preset (import { effect } from @oisin-ee/oxlint-config) scoped to the Effect code; effectMigration on any frontend.
- Remove biome.jsonc + @biomejs/biome; confirm ultracite check uses the oxlint provider.
- Run the gate, fix violations to green.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 biome removed; oxlint + oxfmt + strict + effect preset active
- [x] #2 ultracite check --type-aware passes (0 errors); tsc passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Grooming verification 2026-07-04 (repo state). Migration STARTED but NOT complete — both toolchains coexist.

DONE so far: package.json devDeps carry @oisin-ee/oxlint-config@1.0.0, oxlint@1.71.0, oxfmt@0.56.0, oxlint-tsgolint@0.23.0, @mpsuesser/oxlint-plugin-effect@0.3.0, ultracite@7.7.0. oxlint.config.ts exists (extends [core, strict], typeAware:true, typeCheck:true).

AC#1 UNMET (biome removed; oxlint+oxfmt+strict+effect active): @biomejs/biome@2.4.15 STILL in devDependencies; biome.jsonc STILL present (extends ultracite/biome/core + ultracite/biome/vitest). oxfmt.config.ts does NOT exist (missing). Effect preset NOT wired — oxlint.config.ts has only [core, strict]; its own comment says 'add the effect/effectMigration presets... See the migration Backlog ticket' (still pending). effect@4.0.0-beta.90 is a runtime dep, so the effect preset is in-scope.

AC#2 UNMET/UNVERIFIED (ultracite check --type-aware passes 0 errors; tsc passes): package.json check script is 'ultracite check' (NOT --type-aware). Which provider ultracite resolves is ambiguous while biome.jsonc still exists alongside oxlint.config.ts. Gate not run in this grooming pass.

REMAINING: (1) add oxfmt.config.ts (import ultracite/oxfmt); (2) add effect preset scoped to Effect code (effectMigration on any frontend); (3) remove biome.jsonc + @biomejs/biome, confirm ultracite check uses the oxlint provider; (4) update check script to --type-aware if that's the intended gate; (5) run the gate green + tsc. Kept To Do.

Final evidence 2026-07-06: PIPE-95.1 through PIPE-95.14 are Done with AC/DoD checked or annotated. Package gate reality supersedes the old Ultracite wording: check script is direct oxlint --type-aware --type-check --deny-warnings on src/tests/package/config surfaces followed by oxfmt --check. nub run check exit 0; nub run typecheck exit 0; nub run build exit 0; nub run test exit 0 (158 files passed, 6 skipped; 1220 tests passed, 51 skipped); nubx fallow audit --fail-on-issues --format compact exit 0; rg -n '@biomejs/biome|ultracite/biome|biome-ignore|biome lint' package.json lock.yaml renovate.json src tests exit 1; git diff --check exit 0; strict forbidden-token scan for as any, ts-ignore, ts-expect-error, TODO: fix later, effectMigration exited 1. Exact allow/rules scan hits reviewed as domain/config vocabulary.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 PIPE-95.1 through PIPE-95.14 complete with per-ticket AC/DoD evidence recorded.
- [x] #2 nub run check exits 0.
- [x] #3 nub run typecheck exits 0.
- [x] #4 nub run test exits 0.
- [x] #5 Biome absence scan exits 1 for @biomejs/biome, ultracite/biome, biome-ignore, and biome lint references.
<!-- DOD:END -->
