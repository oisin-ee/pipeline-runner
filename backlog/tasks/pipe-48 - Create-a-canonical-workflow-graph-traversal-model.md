---
id: PIPE-48
title: Create a canonical workflow graph traversal model
status: To Do
assignee: []
created_date: '2026-06-04 14:41'
labels:
  - tech-debt
  - maintainability
  - workflow-planner
  - config
  - schedule
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/workflow-planner.ts
  - src/schedule-planner.ts
  - src/config.ts
  - tests/workflow-planner.test.ts
  - tests/schedule-planner.test.ts
  - tests/config.test.ts
priority: medium
ordinal: 115000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow node traversal and graph reasoning are implemented separately in schedule planning, config validation, and workflow planning. This makes each new workflow primitive or nested-node behavior more expensive and increases the risk that validation, planning, and scheduling disagree. Introduce a canonical workflow graph/traversal model that the relevant layers can share without leaking unrelated responsibilities.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A shared workflow graph/traversal API covers nested node flattening, dependency lookup, downstream traversal, and cycle/dependency reasoning needed by config validation, workflow planning, and schedule validation.
- [ ] #2 Existing config validation, workflow planning, and schedule validation behavior is preserved or intentionally tightened with tests.
- [ ] #3 Duplicate ad hoc traversal helpers are removed or reduced in the affected modules.
- [ ] #4 The shared model does not become a broad dumping ground; each caller still owns its layer-specific policy decisions.
- [ ] #5 Tests cover nested parallel/workflow cases through the shared traversal behavior and representative public planner/config APIs.
<!-- AC:END -->
