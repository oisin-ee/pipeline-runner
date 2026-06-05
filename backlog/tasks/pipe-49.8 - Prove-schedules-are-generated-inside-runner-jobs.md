---
id: PIPE-49.8
title: Prove schedules are generated inside runner jobs
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - schedule
  - artifacts
dependencies:
  - PIPE-49.2
  - PIPE-49.5
references:
  - src/schedule-planner.ts
  - src/pipeline-runtime.ts
modified_files:
  - tests
parent_task_id: PIPE-49
priority: high
ordinal: 124000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verify scheduled entrypoints used by runner-job generate ticket-specific schedules and run artifacts inside the clean workspace instead of requiring precommitted schedule files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A clean workspace scheduled run generates .pipeline/runs/<runId>/schedule.yaml inside /workspace.
- [ ] #2 Runner-job does not require a ticket-specific schedule in the repository before execution.
- [ ] #3 Generated schedule validation/explain coverage runs against the in-job artifact.
- [ ] #4 Schedule planner remains unaware of Kubernetes and /workspace conventions.
- [ ] #5 Tests or dogfood evidence inspect the generated schedule artifact.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add focused runner-job/runtime coverage around scheduled entrypoints and assert artifact paths live under the prepared workspace.
<!-- SECTION:PLAN:END -->
