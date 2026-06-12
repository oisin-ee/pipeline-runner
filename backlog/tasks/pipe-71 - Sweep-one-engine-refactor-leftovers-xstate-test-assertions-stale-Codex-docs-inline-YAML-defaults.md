---
id: PIPE-71
title: >-
  Sweep one-engine refactor leftovers (xstate test assertions, stale Codex docs,
  inline YAML defaults)
status: In Progress
assignee: []
created_date: '2026-06-12 20:09'
updated_date: '2026-06-12 20:27'
labels:
  - 'repo:pipeline'
  - phase-1
  - hygiene
dependencies: []
references:
  - report/architecture-review-2026-06-12.md
priority: medium
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three vestigial items from the xstate elimination and Codex removal:

1. Tests still assert `!toContain("@xstate")` in src/runtime/gates/gates.test.ts:225 and src/runtime/hooks/hooks.test.ts:228 — delete or replace with a meaningful dependency-boundary check.
2. README/docs still mention Codex compatibility; runtime is OpenCode-only. Align docs with reality.
3. src/config/defaults.ts (541 lines) embeds package defaults as inline YAML strings. Move them to real files under defaults/ (already shipped via package.json "files") and load them at build/import time, shrinking defaults.ts to a thin loader.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No xstate references remain anywhere in src/ or tests/
- [ ] #2 Docs and README accurately describe OpenCode-only runtime (no stale Codex compatibility claims)
- [ ] #3 Package defaults live as YAML files under defaults/ and defaults.ts is a thin loader
- [ ] #4 pnpm test and pnpm run check pass; packed tarball still contains working defaults (test:dogfood)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: 3 parallel agents, one per sub-item.
1. xstate assertion removal — model=haiku (grep-and-delete).
2. Docs/README Codex sweep — model=haiku (text edits).
3. defaults.ts → defaults/ YAML files + thin loader — model=sonnet (touches build/pack path; verify test:dogfood).
No Opus/Fable anywhere in this task.
<!-- SECTION:PLAN:END -->
