---
id: PIPE-64
title: Split schedule-planner.ts into passes and modules
status: Done
assignee: []
created_date: '2026-06-11 20:40'
updated_date: '2026-06-12 10:28'
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
- [x] #1 src/schedule/{artifact,planner,prompts}.ts and src/schedule/passes/*.ts exist.
- [x] #2 Pass order is documented (coverage -> models -> IDs -> references).
- [x] #3 No public API changes; build succeeds.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
