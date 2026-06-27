---
id: PIPE-45.14
title: Split Argo manifest rendering
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.3
  - PIPE-45.13
references:
  - src/argo-workflow.ts
modified_files:
  - src/argo-workflow.ts
  - tests/argo-workflow.test.ts
  - tests/argo-submit.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 309000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/argo-workflow.ts into manifest model/rendering, retry/resource policy, env/secret projection, and submit integration adapter.
Dependencies: PIPE-45.3, PIPE-45.13
Likely modified files: src/argo-workflow.ts, src/remote/argo/*, tests/argo-workflow.test.ts, tests/argo-submit.test.ts
Reuse: existing YAML/Kubernetes client models and Argo contract tests; no new manifest templater.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Argo manifest rendering is pure and separated from submission/IO -- Evidence: focused renderer tests.
- [ ] #2 Retry/resource/env/secret policies have named single owners -- Evidence: source inspection.
- [ ] #3 Existing Argo tests pass -- Evidence: focused tests.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
