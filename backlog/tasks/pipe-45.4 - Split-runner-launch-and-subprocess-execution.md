---
id: PIPE-45.4
title: Split runner launch and subprocess execution
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/runner.ts
modified_files:
  - src/runner.ts
  - tests/runner.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 299000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/runner.ts into launch planning, subprocess execution, OpenCode excludes, result mapping, and public runner facade.
Dependencies: PIPE-45.1
Likely modified files: src/runner.ts, src/runner/*, tests/runner.test.ts, tests/runner-command*.test.ts
Reuse: execa remains subprocess library; no custom process runner.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runner launch planning and subprocess execution have separate owners -- Evidence: source inspection and focused runner tests.
- [ ] #2 Public ./runner exports remain compatible -- Evidence: package-public-api/dist contract tests.
- [ ] #3 Unsafe catch casts/assertions are removed or explicitly validated at boundaries -- Evidence: quality-gate diff review and typecheck.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
