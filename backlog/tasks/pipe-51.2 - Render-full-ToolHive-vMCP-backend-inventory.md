---
id: PIPE-51.2
title: Render full ToolHive vMCP backend inventory
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
updated_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - toolhive
dependencies:
  - PIPE-51.1
references:
  - src/mcp/toolhive-vmcp.ts
  - tests/mcp-toolhive-vmcp.test.ts
modified_files:
  - src/mcp/toolhive-vmcp.ts
  - tests/mcp-toolhive-vmcp.test.ts
parent_task_id: PIPE-51
priority: high
ordinal: 138000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a gateway reconciliation/rendering module that turns the declared backend contract into the full ToolHive/vMCP backend inventory. When explicit vMCP backends are rendered, the output must always contain the complete aggregate backend list so adding one backend cannot silently drop existing ones.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new src/mcp module renders deterministic vMCP backend config for all declared backends.
- [ ] #2 Rendered config includes every backend in the contract, including shared remote and repo-local entries.
- [ ] #3 Tests prove adding a backend preserves existing context7, uidotsh, qdrant, fallow, serena, and backlog entries when declared.
- [ ] #4 No Codex/OpenCode host config renderer emits direct upstream MCP entries.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement pure ToolHive/vMCP rendering functions in a new src/mcp/toolhive-vmcp.ts module, using the existing yaml dependency for serialization. Do not shell out to ToolHive in unit tests. Export a small typed result consumed later by the reconcile command; leave src/mcp/gateway.ts integration to PIPE-51.4.
<!-- SECTION:PLAN:END -->
