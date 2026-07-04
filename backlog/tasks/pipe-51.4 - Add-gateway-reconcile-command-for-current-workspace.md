---
id: PIPE-51.4
title: Add gateway reconcile command for current workspace
status: Done
assignee: []
created_date: '2026-06-08 15:54'
updated_date: '2026-07-04 19:44'
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
- [x] #1 pipe mcp gateway reconcile resolves workspacePath from PIPELINE_TARGET_PATH or cwd.
- [x] #2 The command refuses to run if it would need to clone, copy, or infer a separate repository workspace.
- [x] #3 The command renders/applies the full backend inventory for the configured ToolHive mode, with tests using mocked execa.
- [x] #4 configure-host output remains singleton-only for Codex and OpenCode.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Wire a Commander subcommand in src/index.ts and delegate implementation to src/mcp. Use existing execa. Unit-test command args and refusal paths; live ToolHive verification belongs to the final dogfood ticket.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered. The reconcile command is registered in src/cli/mcp-gateway-commands.ts (`moka mcp gateway reconcile`), delegating to reconcileGateway() in src/mcp/gateway-reconcile.ts. Resolves workspacePath from PIPELINE_TARGET_PATH || cwd (gateway-reconcile.ts:74; command cwd resolution mcp-gateway-commands.ts:102) (AC#1). It only reads the current workspace and renders the full inventory via renderToolHiveVmcpInventory + resolveRepoLocalBackendSpecs, writing .pipeline/mcp-gateway/vmcp.yaml and validating via McpGatewayService — it never clones/copies a separate repo (AC#2). Applies the complete backend inventory for the configured ToolHive provider (AC#3). configure-host (also in this file) rewrites only opencode/claude-code/codex to the singleton pipeline-gateway (AC#4). Note: ticket referenced src/index.ts + src/mcp/gateway.ts; command wiring now lives in src/cli/mcp-gateway-commands.ts and gateway.ts was split into gateway-config/-reconcile/-doctor/-runtime (commit 5732c6e). Tests: tests/cli.test.ts "reconciles the current workspace into a complete ToolHive vMCP inventory" + "refuses local gateway startup when required ToolHive workloads are missing" (52 tests, execa mocked) — verified green (2026-07-04).
<!-- SECTION:FINAL_SUMMARY:END -->
