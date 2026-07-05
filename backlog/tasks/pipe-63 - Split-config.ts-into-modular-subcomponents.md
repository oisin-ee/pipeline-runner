---
id: PIPE-63
title: Split config.ts into modular subcomponents
status: Done
assignee: []
created_date: "2026-06-11 20:40"
updated_date: "2026-06-12 10:28"
labels:
  - refactor
  - config
dependencies:
  - PIPE-60
priority: medium
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Phase 5: decompose the 2,128-line src/config.ts monolith into focused modules without changing the public export path (package.json exports: {"./config": "./dist/config.js"}). src/config.ts becomes a barrel re-export. New structure: src/config/defaults.ts (~330 lines of embedded YAML defaults), src/config/schemas.ts (Zod type definitions), src/config/load.ts (YAML file loading), src/config/validate.ts (post-load validation, cycle detection, dependency resolution), src/config/lint.ts (warnings for unused profiles, missing schema files). This is pure mechanical refactor - no behavior change, no new abstractions beyond cohesion.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 src/config/{defaults,schemas,load,validate,lint}.ts exist; src/config.ts re-exports the public interface unchanged.
- [x] #2 Zod schemas are cohesive and importable per-layer if needed.
- [x] #3 No public API changes; consumers still do `import { loadPipelineConfig } from "@oisincoveney/pipeline/config"`.
- [x] #4 Tests pass; build succeeds.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.

<!-- SECTION:FINAL_SUMMARY:END -->
