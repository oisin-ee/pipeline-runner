---
id: PIPE-49.2
title: Move runner-job orchestration into dedicated module
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - architecture
dependencies:
  - PIPE-49.1
references:
  - src/kubernetes-runner.ts
  - src/runner-event-sink.ts
modified_files:
  - src/runner-job/run.ts
  - src/kubernetes-runner.ts
parent_task_id: PIPE-49
priority: high
ordinal: 118000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move the current Kubernetes runner-job orchestration into a dedicated runner-job module and remove the old Kubernetes-runner surface entirely.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/runner-job/run.ts exports runRunnerJob.
- [ ] #2 src/kubernetes-runner.ts is deleted.
- [ ] #3 No runKubernetesRunnerJob symbol or kubernetes-runner import remains.
- [ ] #4 Payload validation, event sink setup, signal handling, exit codes, and workflow.finish behavior are preserved.
- [ ] #5 Invalid payload behavior still exits 64 and emits recoverable runner.schema.validation events when possible.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Port the existing orchestration into src/runner-job/run.ts, update runner-job command imports, delete the old file, and update tests/imports directly with no shim.
<!-- SECTION:PLAN:END -->
