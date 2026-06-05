---
id: PIPE-49.7
title: Fix OpenCode gateway remote auth mode
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - mcp
  - opencode
  - auth
dependencies: []
references:
  - src/mcp/gateway.ts
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
- [ ] #1 renderOpenCodeGatewayConfig includes oauth: false for pipeline-gateway remote MCP.
- [ ] #2 Codex gateway config continues using env_http_headers Authorization = PIPELINE_MCP_GATEWAY_AUTHORIZATION.
- [ ] #3 Tests cover generated OpenCode and Codex gateway config.
- [ ] #4 No secrets are written to generated config.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Patch src/mcp/gateway.ts and add focused config-rendering tests.
<!-- SECTION:PLAN:END -->
