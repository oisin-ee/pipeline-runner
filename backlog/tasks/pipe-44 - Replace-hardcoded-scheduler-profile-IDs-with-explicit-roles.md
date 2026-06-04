---
id: PIPE-44
title: Replace hardcoded scheduler profile IDs with explicit roles
status: Done
assignee: []
created_date: '2026-06-04 14:40'
updated_date: '2026-06-04 16:53'
labels:
  - tech-debt
  - maintainability
  - schedule
  - config
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/schedule-planner.ts
  - .pipeline/profiles.yaml
  - src/pipeline-init.ts
  - tests/schedule-planner.test.ts
  - tests/dogfood-installed.test.ts
modified_files:
  - .pipeline/profiles.yaml
  - .pipeline/prompts/schedule-planner.md
  - src/config.ts
  - src/pipeline-init.ts
  - src/schedule-planner.ts
  - tests/schedule-planner.test.ts
priority: high
ordinal: 111000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Schedule planning and validation currently treat specific default profile IDs as semantic roles. For example, implementation coverage detection depends on `pipeline-code-writer`, and coverage detection depends on exact reviewer/verifier profile IDs. This undermines the config-driven model because custom profiles with equivalent intent are not first-class. Introduce an explicit role/capability contract for schedule validation so profile names are not the semantic boundary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Generated schedule validation can identify implementation and coverage nodes without relying on exact default profile IDs.
- [x] #2 Default pipeline profiles continue to validate and behave as they do today.
- [x] #3 Custom profiles can opt into the relevant scheduling roles or capabilities and pass validation when they satisfy the same intent.
- [x] #4 Schedule planner prompts, default config generation, and tests are updated to reflect the role/capability model.
- [x] #5 Installed and dogfood schedule flows continue to validate through the real CLI path.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented explicit scheduling roles for schedule validation. Profiles can now declare implementation or coverage roles, generated defaults declare roles for the built-in implementation/review/verify profiles, planner prompts expose role intent, and validation uses the role contract instead of exact profile IDs. Added regression coverage for custom implementation and coverage profiles, dependency validation, default profile behavior, and no implicit role inference from default profile names.
<!-- SECTION:FINAL_SUMMARY:END -->
