---
id: PIPE-51.6
title: Verify required gateway tools through tools/list
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - doctor
dependencies:
  - PIPE-51.1
  - PIPE-51.2
references:
  - src/mcp/gateway.ts
  - tests/cli.test.ts
modified_files:
  - src/mcp/gateway.ts
  - tests/cli.test.ts
parent_task_id: PIPE-51
priority: high
ordinal: 142000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend gateway doctor so a healthy HTTP endpoint is not enough. Doctor must initialize/list tools through pipeline-gateway and compare the result with the required backend/tool contract for this repo.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipe mcp gateway doctor reports missing required backend/tool prefixes as failures.
- [ ] #2 Doctor output distinguishes gateway health, authorization, legacy direct MCP config, and missing upstream tools.
- [ ] #3 Tests mock MCP tools/list responses and cover pass, missing backend, auth failure, and malformed response cases.
- [ ] #4 Doctor still detects legacy direct MCP config in .codex, .opencode, and .mcp.json.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement minimal MCP initialize/tools-list HTTP calls in src/mcp/gateway.ts using global fetch. Use the configured gateway URL and Authorization header; do not add a new MCP client dependency unless existing protocol handling proves insufficient.
<!-- SECTION:PLAN:END -->
