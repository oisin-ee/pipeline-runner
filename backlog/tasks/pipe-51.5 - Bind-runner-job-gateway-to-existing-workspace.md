---
id: PIPE-51.5
title: Bind runner-job gateway to existing /workspace
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - runner-job
dependencies:
  - PIPE-51.3
  - PIPE-51.4
references:
  - src/runner-job/run.ts
  - src/runner-job/k8s.ts
  - tests/runner-job.test.ts
  - tests/runner-job-k8s.test.ts
modified_files:
  - src/runner-job/run.ts
  - tests/runner-job.test.ts
parent_task_id: PIPE-51
priority: high
ordinal: 141000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Integrate gateway reconciliation into runner-job startup so repo-aware MCP backends bind to the already-prepared runner workspace. This ticket must not change checkout semantics except to consume the worktreePath already returned by prepareRunnerWorkspace.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runner-job startup can run gateway reconciliation after workspace preparation and before pipeline runtime execution.
- [ ] #2 Gateway env passed to child agents uses the reconciled gateway URL/token and PIPELINE_TARGET_PATH equal to the prepared worktreePath.
- [ ] #3 Kubernetes manifest support, if needed, mounts only existing auth/payload/workspace-related volumes and does not introduce a second repo volume or init clone for MCP.
- [ ] #4 Tests prove prepareRunnerWorkspace is called once and gateway reconciliation receives the same worktreePath.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a runner-job integration seam in src/runner-job/run.ts with injectable reconcile function for tests. Avoid adding Kubernetes API calls to the in-pod runner. Keep src/runner-job/k8s.ts changes limited to config/secret wiring if the command needs it.
<!-- SECTION:PLAN:END -->
