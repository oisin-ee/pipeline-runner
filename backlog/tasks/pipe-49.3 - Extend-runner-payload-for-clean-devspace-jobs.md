---
id: PIPE-49.3
title: Extend runner payload for clean devspace jobs
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - contract
  - devspace
dependencies:
  - PIPE-49.1
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
