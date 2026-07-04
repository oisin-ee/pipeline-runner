---
id: PIPE-49.5
title: Gate clean jobs on devspace and pipeline baseline
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
updated_date: '2026-07-04 19:40'
labels:
  - runner-job
  - devspace
  - validation
dependencies: []
references:
  - src/config.ts
modified_files:
  - src/runner-job/devspace.ts
  - src/runner-job/run.ts
parent_task_id: PIPE-49
priority: high
ordinal: 121000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add runner-job readiness checks that prove the clean checkout is a devspace repository with stable pipeline baseline before invoking the pipeline engine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runner-job validates /workspace/devspace.yaml exists for clean devspace mode.
- [ ] #2 Runner-job validates stable pipeline config can be loaded from /workspace.
- [ ] #3 Missing devspace.yaml fails before pipeline runtime execution.
- [ ] #4 Missing or invalid stable pipeline config fails before agent execution.
- [ ] #5 Devspace and config validation logic lives under runner-job modules, not pipeline runtime.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create src/runner-job/devspace.ts and readiness checks called from runRunnerJob before runPipelineFromConfig.
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: grooming
created: 2026-07-04 19:40
---
ARCHIVE — obsolete/superseded. Gates clean jobs on /workspace/devspace.yaml + stable pipeline baseline via `src/runner-job/devspace.ts`. That file (77 lines) was deleted in 269f097 'feat: moka', and `devspace` appears nowhere in `src/` today (`git grep -l devspace -- 'src/**'` returns nothing). The devspace-repo readiness concept was abandoned with the moka/Argo pivot.
---
<!-- COMMENTS:END -->
