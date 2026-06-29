---
id: PIPE-94.4
title: moka submit upserts createRun + schedule when db.url reachable
status: Done
assignee: []
created_date: '2026-06-28 19:52'
updated_date: '2026-06-28 20:53'
labels: []
dependencies:
  - PIPE-94.1
modified_files:
  - src/remote/submit/service.ts
  - src/remote/submit/argo-submission.ts
parent_task_id: PIPE-94
priority: high
ordinal: 325000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: in the submit path, when loadMokaDbUrl resolves and the store is reachable, call createRun (idempotent upsert) + persist schedule BEFORE launching Argo so the run shows in the console as pending. Guarded: a DB-less submitter (no db.url / unreachable) still submits successfully (createRun skipped, runner-lifecycle floor covers it). Never block submit on client DB access.
Dependencies: PIPE-94.1
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 submit with reachable db.url creates the manifest (+schedule) before Argo submission -- Evidence: test asserts store.createRun called pre-submit; readRun shows pending
- [ ] #2 submit with no/unreachable db.url still submits the Argo workflow, no throw -- Evidence: test of the DB-less branch
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
