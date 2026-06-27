---
id: PIPE-45.13
title: Split remote submit service
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.2
  - PIPE-45.5
references:
  - src/moka-submit.ts
modified_files:
  - src/moka-submit.ts
  - tests/moka-submit.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 308000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/moka-submit.ts into input contract, graph compilation, Argo submission service, event sink/auth handling, and CLI-facing facade.
Dependencies: PIPE-45.2, PIPE-45.5
Likely modified files: src/moka-submit.ts, src/remote/submit/*, tests/moka-submit.test.ts
Reuse: ky/fetch/event sink contracts and existing Zod submit schemas; no custom HTTP client.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Submit contract, compilation, IO, and event/auth handling have separate owners -- Evidence: source inspection.
- [ ] #2 Public ./moka-submit contract remains compatible -- Evidence: package API/dist tests and moka-submit tests pass.
- [ ] #3 Security-sensitive auth data remains boundary-validated and not logged -- Evidence: security/quality review.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow plus security lens for auth/event boundaries; record proof.
<!-- DOD:END -->
