---
id: PIPE-51.6
title: Verify required gateway tools through tools/list
status: Done
assignee: []
created_date: "2026-06-08 15:54"
updated_date: "2026-07-04 19:44"
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

- [x] #1 pipe mcp gateway doctor reports missing required backend/tool prefixes as failures.
- [x] #2 Doctor output distinguishes gateway health, authorization, legacy direct MCP config, and missing upstream tools.
- [x] #3 Tests mock MCP tools/list responses and cover pass, missing backend, auth failure, and malformed response cases.
- [x] #4 Doctor still detects legacy direct MCP config in .codex, .opencode, and .mcp.json.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Implement minimal MCP initialize/tools-list HTTP calls in src/mcp/gateway.ts using global fetch. Use the configured gateway URL and Authorization header; do not add a new MCP client dependency unless existing protocol handling proves insufficient.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Delivered. src/mcp/gateway-doctor.ts runGatewayDoctor() goes beyond an HTTP health probe: checkGatewayRequiredTools() computes required tool prefixes from backends where required===true, calls MCP `initialize` then `tools/list` over the configured gateway URL with the Authorization header (listGatewayTools, lines 203-234), and reports any required prefix with no matching tool as a failure (AC#1). Distinct checks separate gateway health, authorization, legacy direct MCP config (checkLegacyDirectMcp scans .mcp.json, .opencode/opencode.json, .pipeline/profiles.yaml), and missing upstream tools (AC#2/#4). RPC goes through McpGatewayService.callGatewayRpc using global fetch — no new MCP client dep. Malformed tools/list responses fail with PipelineMcpGatewayError. Tests: tests/cli.test.ts "gateway doctor detects legacy direct MCP config" + "gateway doctor fails when required upstream tools are missing" (mocks global.fetch for tools/list, covers pass/missing/auth/malformed) — verified green (2026-07-04). Note: doctor now lives in gateway-doctor.ts (gateway.ts split, 5732c6e), not gateway.ts.

<!-- SECTION:FINAL_SUMMARY:END -->
