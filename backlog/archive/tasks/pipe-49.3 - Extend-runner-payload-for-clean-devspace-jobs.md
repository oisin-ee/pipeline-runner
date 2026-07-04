---
id: PIPE-49.3
title: Extend runner payload for clean devspace jobs
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
updated_date: '2026-07-04 19:40'
labels:
  - runner-job
  - contract
  - devspace
dependencies: []
references:
  - src/runner-job-contract.ts
modified_files:
  - src/runner-job-contract.ts
parent_task_id: PIPE-49
priority: high
ordinal: 119000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the shared runner payload contract explicitly model clean devspace runner jobs while keeping Console as a parameter-passing caller.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Clean devspace mode requires repository clone URL, full name, branch, and exact SHA.
- [ ] #2 Clone credential configuration references env/secret names only and never includes secret values.
- [ ] #3 Selector fields needed by runner-job are validated before a pod reaches runtime execution.
- [ ] #4 Malformed or incomplete clean devspace payloads exit through the existing validation path with exit 64.
- [ ] #5 Exported JSON schema reflects the new contract.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Extend Zod schemas and builder options in runner-job-contract, add validation tests, and keep Console-facing contract as the only shared surface.
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: grooming
created: 2026-07-04 19:40
---
ARCHIVE — obsolete/superseded. Extends `src/runner-job-contract.ts` with a 'clean devspace' payload mode (clone URL/SHA, OISIN_PIPELINE_RUNNER_PAYLOAD_JSON). `src/runner-job-contract.ts` was deleted in 269f097 'feat: moka'; OISIN_PIPELINE_RUNNER_PAYLOAD_JSON and any devspace mode appear nowhere in `src/` now. The shared contract surface today is `src/runner-command-contract.ts` + `src/workflow-submit-contract.ts` for moka/Argo, which has no devspace-clone concept.
---
<!-- COMMENTS:END -->
