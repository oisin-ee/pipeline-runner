---
id: PIPE-49.4
title: Implement clean workspace checkout bootstrap
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - workspace
  - git
dependencies:
  - PIPE-49.3
references:
  - src/runner-job-contract.ts
  - package.json
modified_files:
  - src/runner-job/workspace.ts
  - src/runner-job/credentials.ts
parent_task_id: PIPE-49
priority: high
ordinal: 120000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add runner-job workspace preparation that clones the requested repository into /workspace and checks out the exact requested SHA before invoking the pipeline engine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Workspace bootstrap uses existing simple-git dependency for clone/checkout orchestration.
- [ ] #2 Bootstrap returns worktreePath /workspace for clean devspace jobs.
- [ ] #3 PIPELINE_TARGET_PATH is prepared for downstream process environment.
- [ ] #4 Checkout failures are redacted and do not leak credentials.
- [ ] #5 Tests cover clone target, exact SHA checkout, env preparation, and redacted errors.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create src/runner-job/workspace.ts and credentials helper module, inject simple-git for tests, and keep all /workspace assumptions inside runner-job modules.
<!-- SECTION:PLAN:END -->
