---
id: PIPE-64
title: Split schedule-planner.ts into passes and modules
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
labels:
  - refactor
  - schedule
dependencies:
  - PIPE-60
priority: medium
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5: decompose the 1,869-line src/schedule-planner.ts monolith into: src/schedule/artifact.ts (schema definitions), src/schedule/planner.ts (agent invocation), src/schedule/prompts.ts (planner instruction templates), src/schedule/passes/ (transformation passes: coverage-injection, model-fallbacks, id-canonicalization, reference-rewriting, each ~200 lines). These passes are applied in sequence during compilation; breaking them out makes the compilation pipeline auditable (see-one-pass-at-a-time debugging). src/schedule-planner.ts becomes a barrel. Public export path unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/schedule/{artifact,planner,prompts}.ts and src/schedule/passes/*.ts exist.
- [ ] #2 Pass order is documented (coverage -> models -> IDs -> references).
- [ ] #3 No public API changes; build succeeds.
<!-- AC:END -->
