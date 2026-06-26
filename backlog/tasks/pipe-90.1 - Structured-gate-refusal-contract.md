---
id: PIPE-90.1
title: Structured gate-refusal contract
status: Done
assignee: []
created_date: '2026-06-26 14:24'
updated_date: '2026-06-26 15:48'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/contracts/contracts.ts
parent_task_id: PIPE-90
priority: high
ordinal: 262000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: extend the gate result type so refusal carries structured, actionable reasons instead of a bare boolean. Shape: { passed, unmet: [{ criterion, reason, evidence }] }. This is the shared contract every other Layer-A ticket consumes; cut first.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RuntimeGateResult carries an unmet[] of { criterion, reason, evidence } -- Evidence: type def + unit test asserting a failed gate populates unmet[] with all unmet criteria
- [ ] #2 Existing binary-passing gates still compile and pass (back-compat: empty unmet[] on pass) -- Evidence: pnpm run check + existing gate tests green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + targeted gate tests ran fresh; output recorded
<!-- DOD:END -->
