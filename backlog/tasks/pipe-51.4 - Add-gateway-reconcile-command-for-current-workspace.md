---
id: PIPE-51.4
title: Add gateway reconcile command for current workspace
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - cli
dependencies:
  - PIPE-51.2
  - PIPE-51.3
references:
  - src/index.ts
  - src/mcp/gateway.ts
  - tests/cli.test.ts
modified_files:
  - src/index.ts
  - src/mcp/gateway.ts
  - tests/cli.test.ts
parent_task_id: PIPE-51
priority: high
ordinal: 140000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a CLI command that reconciles the current project's gateway from the declared contract and active workspace. This command prepares/registers the complete backend inventory for the current repo and prints actionable evidence, while leaving host configs pointed only at pipeline-gateway.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipe mcp gateway reconcile resolves workspacePath from PIPELINE_TARGET_PATH or cwd.
- [ ] #2 The command refuses to run if it would need to clone, copy, or infer a separate repository workspace.
- [ ] #3 The command renders/applies the full backend inventory for the configured ToolHive mode, with tests using mocked execa.
- [ ] #4 configure-host output remains singleton-only for Codex and OpenCode.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Wire a Commander subcommand in src/index.ts and delegate implementation to src/mcp. Use existing execa. Unit-test command args and refusal paths; live ToolHive verification belongs to the final dogfood ticket.
<!-- SECTION:PLAN:END -->
