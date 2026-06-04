---
id: PIPE-44
title: Replace hardcoded scheduler profile IDs with explicit roles
status: To Do
assignee: []
created_date: '2026-06-04 14:40'
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
priority: high
ordinal: 111000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Schedule planning and validation currently treat specific default profile IDs as semantic roles. For example, implementation coverage detection depends on `pipeline-code-writer`, and coverage detection depends on exact reviewer/verifier profile IDs. This undermines the config-driven model because custom profiles with equivalent intent are not first-class. Introduce an explicit role/capability contract for schedule validation so profile names are not the semantic boundary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Generated schedule validation can identify implementation and coverage nodes without relying on exact default profile IDs.
- [ ] #2 Default pipeline profiles continue to validate and behave as they do today.
- [ ] #3 Custom profiles can opt into the relevant scheduling roles or capabilities and pass validation when they satisfy the same intent.
- [ ] #4 Schedule planner prompts, default config generation, and tests are updated to reflect the role/capability model.
- [ ] #5 Installed and dogfood schedule flows continue to validate through the real CLI path.
<!-- AC:END -->
