---
id: PIPE-49.9
title: Add devspace smoke command contract
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - devspace
  - verification
dependencies:
  - PIPE-49.5
references:
  - src/config.ts
  - src/pipeline-init.ts
modified_files:
  - src/runner-job/devspace.ts
  - src/config.ts
parent_task_id: PIPE-49
priority: high
ordinal: 125000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define how a devspace repo declares real smoke/test commands for runner-job verification without hardcoding repository behavior in Pipeline Console.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Stable pipeline config can declare devspace smoke/test commands for runner-job verification.
- [ ] #2 Runner-job discovers the declared command from the clean checkout, not from Console-specific behavior.
- [ ] #3 Configured smoke command failures are reported as runner-job/readiness or verification events with command evidence.
- [ ] #4 Repos without declared smoke commands are handled explicitly according to config policy, not by silent fallback.
- [ ] #5 No devspace smoke logic is added to pipeline runtime or scheduler modules.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Extend stable config schema/defaults if needed, add runner-job devspace smoke resolver, and test command discovery/failure behavior.
<!-- SECTION:PLAN:END -->
