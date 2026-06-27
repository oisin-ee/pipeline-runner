---
id: PIPE-45.12
title: Split gates and hooks by kind and policy
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.10
references:
  - src/runtime/hooks/hooks.ts
modified_files:
  - src/runtime/hooks/hooks.ts
  - src/runtime/gates/gates.ts
  - tests/gates.test.ts
  - tests/install-hooks.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 307000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split hook execution, hook policy, gate evaluation, artifact/quality gates, and event rendering into focused modules.
Dependencies: PIPE-45.10
Likely modified files: src/runtime/gates/gates.ts, src/runtime/hooks/hooks.ts, src/runtime/gates/*, src/runtime/hooks/*, tests/gates.test.ts, tests/install-hooks.test.ts
Reuse: existing hook/gate contracts and shell execution helpers; no alternate policy engine.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hook and gate policies are separated by kind/owner -- Evidence: source inspection.
- [ ] #2 Gate/hook tests pass with no added suppressions -- Evidence: focused tests and check output.
- [ ] #3 No silent error handling or broad fallback defaults are introduced -- Evidence: quality-gate review.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
