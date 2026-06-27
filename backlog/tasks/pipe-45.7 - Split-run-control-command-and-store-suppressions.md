---
id: PIPE-45.7
title: Split run-control command and store suppressions
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/run-control/commands.ts
  - src/run-control/store.ts
modified_files:
  - src/run-control/commands.ts
  - src/run-control/store.ts
  - tests/run-control-commands.test.ts
  - tests/run-control-store.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 302000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split run-control CLI command concerns from store contracts/projections/writers and remove suppressions that hide ownership problems.
Dependencies: PIPE-45.1
Likely modified files: src/run-control/commands.ts, src/run-control/store.ts, src/run-control/*, tests/run-control-*.test.ts
Reuse: existing run-control store contracts and postgres/file implementations; no new persistence layer.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Run-control command parsing/output and store semantics have separate owners -- Evidence: source inspection.
- [ ] #2 Existing run-control tests pass without added suppressions -- Evidence: focused tests and ultracite output.
- [ ] #3 No broad fallbacks or silent error handling are introduced -- Evidence: quality-gate review.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
