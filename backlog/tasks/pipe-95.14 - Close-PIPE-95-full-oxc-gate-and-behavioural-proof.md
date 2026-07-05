---
id: PIPE-95.14
title: Close PIPE-95 full oxc gate and behavioural proof
status: To Do
assignee: []
created_date: '2026-07-05 19:19'
updated_date: '2026-07-05 19:19'
labels:
  - migration
dependencies:
  - PIPE-95.13
references:
  - >-
    backlog/tasks/pipe-95 -
    Complete-Biome-oxc-strict-Effect-lint-migration-oisin-ee-oxlint-config.md
  - oxlint.config.ts
  - oxfmt.config.ts
modified_files:
  - src
  - tests
  - package.json
  - lock.yaml
  - renovate.json
  - oxlint.config.ts
  - oxfmt.config.ts
  - backlog/tasks
parent_task_id: PIPE-95
priority: medium
ordinal: 359000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Finish PIPE-95 by fixing only final residual diagnostics after all scoped slices, proving the full oxc/oxfmt/type/test gates, and updating Backlog evidence.
Scope: final residual source/test/config fixes named by fresh gates plus Backlog evidence updates for PIPE-95 child tickets. Do not broaden config ignores, disable rules, switch to effectMigration, reintroduce Biome, or add suppressions to hide violations.
Dependencies / Blocked by: PIPE-95.13.
Likely modified files: residual src/**/*.ts, tests/**/*.ts, package.json, lock.yaml, renovate.json, oxlint.config.ts, oxfmt.config.ts, backlog/tasks/pipe-95*.md.
Research required: run fresh full gates first; inspect rule docs/help for any unfamiliar residual rule; inspect package-manager state before lock/package edits.
Model recommendation:
- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- current host exposes gpt-5.5; final acceptance and broad verification.
- OpenCode: moka-code-writer/default plus moka-acceptance-reviewer/default -- dispatch must revalidate live availability.
Escalation:
- Met: full PIPE-95 acceptance passes with evidence.
- Unmet: record failing command, first diagnostic cluster, affected files, and why another rescope is needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Strict/type-aware lint and formatting are green with no Biome fallback. -- Evidence: `nub run check` exits 0 and `rg -n '@biomejs/biome|ultracite/biome|biome-ignore' package.json lock.yaml renovate.json src tests` exits 1.
- [ ] #2 TypeScript and behavioural safety remain green. -- Evidence: `nub run typecheck` exits 0 and `nub run test` exits 0.
- [ ] #3 No shortcut suppressions or type escapes were introduced while finishing the migration. -- Evidence: `git diff --check` exits 0 and `git diff -U0 -- src tests oxlint.config.ts package.json | rg -n '^\+.*(as any|@ts-ignore|@ts-expect-error|TODO: fix later|workaround|effectMigration|rules:|allow)'` exits 1 unless an existing config field is listed as unchanged.
- [ ] #4 Backlog reflects the finished migration. -- Evidence: PIPE-95.1 through PIPE-95.14 AC/DoD are checked or annotated with exact proof, and parent PIPE-95 acceptance is updated only after gates pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Run full gates, fix only residual diagnostics at source, run `nub run check`, `nub run typecheck`, `nub run test`, Biome absence and shortcut scans, update Backlog AC/DoD evidence, then hand to critique/verify before commit.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof and full proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
