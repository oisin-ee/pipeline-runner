---
id: PIPE-71
title: >-
  Sweep one-engine refactor leftovers (xstate test assertions, stale Codex docs,
  inline YAML defaults)
status: Done
assignee: []
created_date: '2026-06-12 20:09'
updated_date: '2026-07-04 18:55'
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
- [x] #1 No xstate references remain anywhere in src/ or tests/
- [x] #2 Docs and README accurately describe OpenCode-only runtime (no stale Codex compatibility claims)
- [x] #3 Package defaults live as YAML files under defaults/ and defaults.ts is a thin loader
- [x] #4 pnpm test and pnpm run check pass; packed tarball still contains working defaults (test:dogfood)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: 3 parallel agents, one per sub-item.
1. xstate assertion removal — model=haiku (grep-and-delete).
2. Docs/README Codex sweep — model=haiku (text edits).
3. defaults.ts → defaults/ YAML files + thin loader — model=sonnet (touches build/pack path; verify test:dogfood).
No Opus/Fable anywhere in this task.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Done (stale In-Progress flag; work had shipped). 1) No xstate dependency remains in src/; the residual `xstate` string hits in tests/ are the intended dependency-boundary guards (runtime-actor-contract-boundary.test.ts asserts `.not.toContain("xstate")` in package metadata/lockfile and that runtime gate/hook evaluation is inlined without xstate machines) — exactly the "meaningful dependency-boundary check" the ticket called for, not a leftover. 2) docs/operator-guide.md states "Codex is not a supported runtime host"; the opencode-first ADR status header records "Codex compatibility subsequently removed" — the ADR body keeps its original decision context as an immutable historical record. 3) src/config/defaults.ts is now a 181-line thin loader (was 541) and package defaults live as real YAML under defaults/ (pipeline.yaml, profiles.yaml, runners.yaml, opencode-ecosystem.yaml). 4) Verified via the merged commits' CI; targeted moka/argo suite re-run green locally (75/75).
<!-- SECTION:FINAL_SUMMARY:END -->
