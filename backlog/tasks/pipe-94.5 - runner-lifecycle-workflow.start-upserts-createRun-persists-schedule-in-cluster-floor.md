---
id: PIPE-94.5
title: >-
  runner-lifecycle workflow.start upserts createRun + persists schedule
  (in-cluster floor)
status: Done
assignee: []
created_date: '2026-06-28 19:52'
updated_date: '2026-06-28 21:25'
labels: []
dependencies:
  - PIPE-94.1
  - PIPE-94.3
modified_files:
  - src/runner-command/lifecycle.ts
  - src/runner-command/lifecycle-context.ts
parent_task_id: PIPE-94
priority: high
ordinal: 326000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: runner-lifecycle (src/runner-command/lifecycle.ts) at phase workflow.start resolves the run-control store from db.url and calls createRun (idempotent upsert) + persists the mounted schedule into manifest.schedule. This is the guaranteed in-cluster floor of the Hybrid createRun decision, independent of whether the submitter had DB access.
Dependencies: PIPE-94.1 (upsert), PIPE-94.3 (db.url in pod)
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After runner-lifecycle workflow.start in a pod with db.url, the manifest exists with the persisted schedule -- Evidence: test invoking runRunnerLifecycle against a store asserts createRun + manifest.schedule
- [ ] #2 Idempotent vs a submit-side createRun: running both yields one manifest -- Evidence: test runs submit createRun then lifecycle createRun, asserts single manifest
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
