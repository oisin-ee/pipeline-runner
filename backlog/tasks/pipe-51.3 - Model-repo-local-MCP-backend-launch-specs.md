---
id: PIPE-51.3
title: Model repo-local MCP backend launch specs
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
updated_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - workspace
dependencies:
  - PIPE-51.1
references:
  - src/mcp/repo-local-backends.ts
  - tests/mcp-repo-local-backends.test.ts
modified_files:
  - src/mcp/repo-local-backends.ts
  - tests/mcp-repo-local-backends.test.ts
parent_task_id: PIPE-51
priority: high
ordinal: 139000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define repo-local backend specs for filesystem-aware MCP servers such as serena, backlog, and fallow. These specs must run against the active workspace path only: local cwd/PIPELINE_TARGET_PATH for developer runs and already-prepared /workspace for runner jobs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Repo-local backend specs receive workspacePath from PIPELINE_TARGET_PATH or process cwd, never from a clone URL.
- [ ] #2 serena/backlog/fallow specs include cwd, mount/path, env, and tool prefix metadata needed by the gateway renderer.
- [ ] #3 Tests prove workspacePath is reused exactly and no clone/copy command is generated.
- [ ] #4 Missing required repo-local files, such as .serena/project.yml or backlog/, are represented as readiness failures or disabled optional backends according to the declared contract.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement pure repo-local backend spec helpers in a new src/mcp/repo-local-backends.ts module. Use PIPELINE_TARGET_PATH/cwd as the workspace source, return explicit readiness/spec data for serena/backlog/fallow, and keep process execution wiring out of this ticket. Integration with gateway.ts belongs to PIPE-51.4.
<!-- SECTION:PLAN:END -->
