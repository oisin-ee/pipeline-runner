---
id: PIPE-49.7
title: Fix OpenCode gateway remote auth mode
status: Done
assignee: []
created_date: "2026-06-05 12:27"
updated_date: "2026-07-04 19:42"
labels:
  - mcp
  - opencode
  - auth
dependencies: []
references:
  - src/mcp/host-renderers.ts
  - src/mcp/gateway-config.ts
  - tests/mcp-gateway-renderers.test.ts
modified_files:
  - src/mcp/gateway.ts
parent_task_id: PIPE-49
priority: high
ordinal: 123000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Render OpenCode MCP gateway config for the hosted pipeline-gateway as header-auth remote MCP, not OAuth.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 renderOpenCodeGatewayConfig includes oauth: false for pipeline-gateway remote MCP.
- [x] #2 Codex gateway config continues using env_http_headers Authorization = PIPELINE_MCP_GATEWAY_AUTHORIZATION.
- [x] #3 Tests cover generated OpenCode and Codex gateway config.
- [x] #4 No secrets are written to generated config.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Patch src/mcp/gateway.ts and add focused config-rendering tests.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Done. Delivered under the reworked MCP layout (mcp module split, commit 5732c6e) — ticket ref src/mcp/gateway.ts is stale; the renderer now lives in src/mcp/host-renderers.ts.

Evidence:

- AC#1 renderOpenCodeGatewayConfig emits oauth: false for the pipeline-gateway remote MCP — src/mcp/host-renderers.ts:22 (inside the `type: "remote"` block).
- AC#2 renderCodexGatewayConfig emits `[mcp_servers.pipeline-gateway.env_http_headers]` with `Authorization = <authorization_env>` where authorization_env defaults to PIPELINE_MCP_GATEWAY_AUTHORIZATION — src/mcp/host-renderers.ts:60-72, default at src/config/schema/mcp.ts:144.
- AC#3 tests/mcp-gateway-renderers.test.ts covers OpenCode (asserts oauth:false, header env-ref, type remote — line 69-77), Claude, and Codex renderers.
- AC#4 no secrets in generated config: headers carry env-var references only ({env:PIPELINE_MCP_GATEWAY_AUTHORIZATION} for OpenCode, ${PIPELINE_MCP_GATEWAY_AUTHORIZATION} for Claude, the env name for Codex) — never a literal token.
<!-- SECTION:FINAL_SUMMARY:END -->
