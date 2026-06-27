---
id: PIPE-45.14
title: Split Argo manifest rendering
status: Done
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
- [x] #1 Argo manifest rendering is pure and separated from submission/IO -- Evidence: boundary assertion in `tests/argo-workflow.test.ts`; `src/argo-workflow.ts` composes pure model/policy/storage/templates and does not import Kubernetes IO.
- [x] #2 Retry/resource/env/secret policies have named single owners -- Evidence: `src/remote/argo/policy.ts` owns retry/resource/env/deadline policy; `src/remote/argo/storage.ts` owns event/git/GitHub secret projection; `src/remote/argo/templates.ts` owns runner templates.
- [x] #3 Existing Argo tests pass -- Evidence: `bun run test tests/argo-workflow.test.ts tests/argo-submit.test.ts tests/moka-submit.test.ts tests/package-public-api.test.ts` passed, 4 files / 53 tests.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
