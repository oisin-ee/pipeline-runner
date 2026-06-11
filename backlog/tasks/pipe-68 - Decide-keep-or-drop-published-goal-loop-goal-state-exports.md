---
id: PIPE-68
title: 'Decide: keep or drop published goal-loop/goal-state exports'
status: To Do
assignee: []
created_date: '2026-06-11 20:41'
labels:
  - refactor
  - decisions
dependencies: []
priority: medium
ordinal: 200000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Decision ticket: src/runtime/goal-loop/ (227 lines) and src/runtime/goal-state/ (510 lines) have zero production importers in this repo, but they ARE published exports (./runtime/goal-loop, ./runtime/goal-state in package.json). Investigation shows: they may be used by Pipeline Console or other consumers. ACTION: owner to check if pipeline-console depends on these exports. If not used, remove from package.json exports (breaking change, bump major). If used, keep as-is. This ticket blocks Phase 1 deletion (PIPE-58 explicitly skips them pending this decision).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Owner verifies: does pipeline-console import from "./runtime/goal-loop" or "./runtime/goal-state"?
- [ ] #2 If no external consumer found: mark for deletion in next major release (document in CHANGELOG, update package.json).
- [ ] #3 If consumer found: keep and document the use case.
<!-- AC:END -->
