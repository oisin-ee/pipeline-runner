---
id: PIPE-51.2
title: Render full ToolHive vMCP backend inventory
status: Done
assignee: []
created_date: "2026-06-08 15:54"
updated_date: "2026-07-04 19:44"
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

- [x] #1 A new src/mcp module renders deterministic vMCP backend config for all declared backends.
- [x] #2 Rendered config includes every backend in the contract, including shared remote and repo-local entries.
- [x] #3 Tests prove adding a backend preserves existing context7, uidotsh, qdrant, fallow, serena, and backlog entries when declared.
- [x] #4 No Codex/OpenCode host config renderer emits direct upstream MCP entries.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Implement pure ToolHive/vMCP rendering functions in a new src/mcp/toolhive-vmcp.ts module, using the existing yaml dependency for serialization. Do not shell out to ToolHive in unit tests. Export a small typed result consumed later by the reconcile command; leave src/mcp/gateway.ts integration to PIPE-51.4.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Delivered. src/mcp/toolhive-vmcp.ts renderToolHiveVmcpInventory() turns the declared backend contract into a deterministic ToolHive/vMCP inventory: iterates every entry in gateway.backends (AC#1), emits both entry-type (shared/scoped remote) and stdio-type (repo-local) backends into one aggregate list sorted by name, so adding a backend cannot drop existing ones (AC#2/#3). Uses the `yaml` dependency's stringify for serialization (no shell-out). Host renderers emit only the singleton pipeline-gateway, never direct upstream MCP entries (src/mcp/host-config.ts / host-renderers.ts; verified by opencode-project-gateway-scope.test.ts) (AC#4). Tests: tests/mcp-toolhive-vmcp.test.ts (3 tests) prove full inventory preservation across context7/uidotsh/qdrant/fallow/serena/backlog — verified green (2026-07-04). Original impl 9aec92b, routed through Effect RepoIoService since.

<!-- SECTION:FINAL_SUMMARY:END -->
