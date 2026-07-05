---
id: PIPE-95.1
title: 'Activate oxlint, oxfmt, and Effect presets for PIPE-95'
status: Done
assignee: []
created_date: '2026-07-05 10:53'
updated_date: '2026-07-05 13:57'
labels:
  - migration
dependencies: []
references:
  - >-
    backlog/tasks/pipe-95 -
    Complete-Biome-oxc-strict-Effect-lint-migration-oisin-ee-oxlint-config.md
  - node_modules/@oisin-ee/oxlint-config/README.md
  - node_modules/ultracite/config/oxfmt/index.mjs
modified_files:
  - oxlint.config.ts
  - oxfmt.config.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 346000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Make the oxc/oxfmt configuration load the org strict preset, Effect preset, and Ultracite formatter export as the active config surface. Scope Effect rules to Effect-bearing TypeScript code. This repo has no frontend app in current file inventory; apply effectMigration only if implementation finds real frontend globs, otherwise record none found in notes.
Scope: oxlint and oxfmt config only; do not remove Biome dependencies or fix repo-wide lint fallout in this ticket.
Dependencies / Blocked by: None - can start immediately.
Likely modified files: oxlint.config.ts, oxfmt.config.ts.
Research required: node_modules/@oisin-ee/oxlint-config/README.md, node_modules/@oisin-ee/oxlint-config/dist/effect.d.ts, node_modules/ultracite/config/oxfmt/index.mjs, ./node_modules/.bin/oxlint --help, ./node_modules/.bin/oxfmt --help.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: unknown -- current host identifies Codex GPT-5, but no exact gpt-5.5 tier metadata is exposed.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer; defaults/pipeline.yaml routes implementation nodes through broker/gpt-5.5 fallbacks. Dispatch must revalidate live availability.
  Escalation:
- Met: config exports load and print-config shows strict/effect-backed rules.
- Unmet: record exact import/config error, command output, and package/export checked.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 oxfmt config imports Ultracite oxfmt export and loads under oxfmt. -- Evidence: ./node_modules/.bin/oxfmt -c oxfmt.config.ts --check package.json exits 0 or reports only format differences, not config load errors.
- [x] #2 oxlint config imports strict and effect exports from @oisin-ee/oxlint-config, keeps typeAware/typeCheck enabled, and scopes Effect rules to Effect code. -- Evidence: ./node_modules/.bin/oxlint -c oxlint.config.ts --print-config | rg 'typescript/consistent-type-assertions|effect/'
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-07-05 proof:
- Read node_modules/@oisin-ee/oxlint-config/README.md and dist/effect.d.ts; strict turns on type-aware config and effect is for Effect code.
- Read node_modules/ultracite/config/oxfmt/index.mjs; oxfmt export loads.
- ./node_modules/.bin/oxfmt -c oxfmt.config.ts --check package.json exited 0.
- ./node_modules/.bin/oxfmt -c oxfmt.config.ts --check oxlint.config.ts oxfmt.config.ts exited 0.
- ./node_modules/.bin/oxlint -c oxlint.config.ts --print-config | rg "typeAware|typeCheck|typescript/consistent-type-assertions|effect/avoid-try-catch|effect/" exited 0 and showed strict + full Effect rules.
- No frontend app globs found in current inventory during implementation; effectMigration not applied.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Activated Ultracite oxfmt plus @oisin-ee/oxlint-config strict/effect config. Config load and print-config proof passed; no frontend effectMigration target found.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The ticket's global-rules workflow was run in order.
- [x] #2 Focused proof ran fresh and output was recorded.
- [x] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
