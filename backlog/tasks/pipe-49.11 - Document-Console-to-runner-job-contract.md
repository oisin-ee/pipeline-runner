---
id: PIPE-49.11
title: Document Console to runner-job contract
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - docs
  - contract
dependencies:
  - PIPE-49.3
  - PIPE-49.5
  - PIPE-49.6
  - PIPE-49.9
references:
  - src/runner-job-contract.ts
modified_files:
  - docs
parent_task_id: PIPE-49
priority: high
ordinal: 127000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document the architectural boundary and payload/env contract for Pipeline Console, runner jobs, and devspace repositories.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docs state Pipeline Console passes parameters/secrets and does not generate ticket-specific schedules.
- [ ] #2 Docs state runner-job owns checkout, /workspace, devspace readiness, schedule generation, and event emission.
- [ ] #3 Docs list required payload fields and required secret/env variables.
- [ ] #4 Docs describe stable repo assets versus run artifacts.
- [ ] #5 Docs mention no compatibility shim and no kubernetes-runner surface.
- [ ] #6 Docs state successful runner-job pipeline runs create a GitHub PR after verification and publish the PR URL as run evidence.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Write concise contract documentation referencing exported JSON schema and runner-job module boundaries.
<!-- SECTION:PLAN:END -->
