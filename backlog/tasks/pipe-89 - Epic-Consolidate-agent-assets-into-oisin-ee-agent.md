---
id: PIPE-89
title: "Epic: Consolidate agent assets into oisin-ee/agent"
status: Done
assignee: []
created_date: "2026-06-22 21:02"
updated_date: "2026-06-23 09:40"
labels:
  - epic
dependencies: []
references:
  - /Users/oisin/dev/skills
  - /Users/oisin/dev/agent-rules
  - /Users/oisin/dev/agent-hooks
  - /Users/oisin/dev/oisin-pipeline
priority: high
ordinal: 253000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Problem: skills, rules, and hooks are split across oisin-ee/skills, oisin-ee/rules, and oisin-ee/agent-hooks while oisin-pipeline installs all three during moka init. Scope: consolidate into one physical oisin-ee/agent repo with preserved history, no git submodules, then update oisin-pipeline installers, docs, tests, and scratch install proof. Non-goals: deleting old repos before verification; changing global harness semantics.

<!-- SECTION:DESCRIPTION:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 All child tickets are Done with per-criterion evidence
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Met. Child tickets PIPE-89.1 through PIPE-89.7 are all `Done` with evidence. Consolidated private `oisin-ee/agent` exists and is pushed with skills, rules, and hooks histories preserved; no `.gitmodules`/submodules are present. `oisin-pipeline` installs skills from `oisin-ee/agent/skills`, hooks from `oisin-ee/agent/hooks/<host>`, and rules from `oisin-ee/agent/rules`. Real scratch proofs passed: direct `npx skills add oisin-ee/agent/skills` installed 39 skills, final `node dist/index.js init --force` installed skills/hooks/rules into scratch HOME, and final `node dist/index.js init --check` passed. Final pipeline checks passed: targeted installer suite 79/79, `bun run typecheck`, `bun run check`, `git diff --check`, `bun run build`, and final full `bun run test` 116 files / 909 tests / 4 skipped. Old split repos now carry pushed README deprecation notices pointing to `oisin-ee/agent`.

<!-- SECTION:FINAL_SUMMARY:END -->
