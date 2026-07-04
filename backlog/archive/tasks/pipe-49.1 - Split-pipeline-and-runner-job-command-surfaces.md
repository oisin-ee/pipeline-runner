---
id: PIPE-49.1
title: Split pipeline and runner-job command surfaces
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
updated_date: '2026-07-04 19:40'
labels:
  - runner-job
  - architecture
dependencies: []
references:
  - src/index.ts
modified_files:
  - src/index.ts
  - src/commands/pipeline-command.ts
  - src/commands/runner-job-command.ts
parent_task_id: PIPE-49
priority: high
ordinal: 117000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extract command registration so the pipeline CLI surface and Kubernetes runner-job surface are separate. The pipeline command remains the user-facing pipeline entrypoint; runner-job is a distinct command that will later call the runner-job module.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/index.ts composes command modules instead of owning runner-job orchestration details.
- [ ] #2 Pipeline command registration lives in a dedicated command module.
- [ ] #3 Runner-job command registration lives in a separate command module.
- [ ] #4 Pipeline command code does not import runner-job implementation modules.
- [ ] #5 Existing pipeline CLI commands and configured entrypoints still register.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create command registration modules, move existing registration without behavior changes, then update src/index.ts to compose them.
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: grooming
created: 2026-07-04 19:40
---
ARCHIVE — obsolete/superseded. Targets a command-surface split for a `runner-job` module that no longer exists. `src/commands/runner-job-command.ts` and the whole `src/runner-job/` module were built (f304e97 'feat(runner): add self-contained runner jobs') then DELETED wholesale in 269f097 'feat: moka' (2026-06-10), which replaced the self-contained Kubernetes devspace runner-job architecture with moka submit -> Argo Workflows. Today `src/index.ts` no longer owns command registration at all — it delegates to `src/cli/program`; there is no runner-job command surface to split. Verify: `git show --stat 269f097` lists `src/commands/runner-job-command.ts | 24 -`.
---
<!-- COMMENTS:END -->
