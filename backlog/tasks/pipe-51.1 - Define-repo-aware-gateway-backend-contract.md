---
id: PIPE-51.1
title: Define repo-aware gateway backend contract
status: Done
assignee: []
created_date: '2026-06-08 15:54'
updated_date: '2026-07-04 19:43'
labels:
  - mcp
  - gateway
  - contract
dependencies: []
references:
  - src/config.ts
  - tests/config.test.ts
modified_files:
  - src/config.ts
  - tests/config.test.ts
parent_task_id: PIPE-51
priority: high
ordinal: 137000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend the pipeline config model with an explicit gateway upstream inventory contract. The contract must describe required backend ids/tool prefixes, backend locality (shared remote, repo-local, repo-scoped remote), and the workspace path source used by repo-local backends. It must not reintroduce profile grants for individual upstream MCP servers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mcp_gateway schema accepts a typed upstream/required backend contract while remaining strict for unknown keys.
- [x] #2 Config validation rejects repo-local backend declarations that do not resolve workspace path from PIPELINE_TARGET_PATH or cwd.
- [x] #3 Profiles can still reference only pipeline-gateway when mcp_gateway is configured.
- [x] #4 Tests cover valid config, unknown backend keys, invalid locality, and the singleton profile grant behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/config.ts types/schema/default config parsing. Use existing zod/yaml stack; no new parser. Keep top-level mcp_servers empty/legacy-only and represent upstreams under mcp_gateway, not profile mcp_servers.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered. The mcp_gateway backend contract lives in src/config/schema/mcp.ts (mcpGatewaySchema + mcpGatewayBackendSchema): typed backends record keyed by id with `locality` (enum from schema/catalog.ts MCP_GATEWAY_BACKEND_LOCALITIES: shared-remote / repo-scoped-remote / repo-local), `required` (default true), `tool_prefixes` (min 1), and `workspace_path_source` (PIPELINE_TARGET_PATH|cwd). All objects `.strict()` so unknown keys reject (AC#1). A superRefine rejects repo-local backends missing workspace_path_source and rejects workspace_path_source on non-repo-local backends (AC#2). src/config/validate.ts:295-303 enforces that a profile's mcp_servers may only reference `pipeline-gateway` when mcp_gateway is configured (AC#3). Note: config.ts was mechanically split into src/config/*; the ticket's referenced src/config.ts is now the barrel re-export. Tests: tests/config.test.ts (64 tests) cover valid config, unknown keys, locality validity, and singleton grant — verified green via `vitest run` (2026-07-04). Original impl 9aec92b, refactored through the Effect + config-split work. AC#4 met.
<!-- SECTION:FINAL_SUMMARY:END -->
