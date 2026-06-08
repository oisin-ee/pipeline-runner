---
id: PIPE-51.1
title: Define repo-aware gateway backend contract
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
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
- [ ] #1 mcp_gateway schema accepts a typed upstream/required backend contract while remaining strict for unknown keys.
- [ ] #2 Config validation rejects repo-local backend declarations that do not resolve workspace path from PIPELINE_TARGET_PATH or cwd.
- [ ] #3 Profiles can still reference only pipeline-gateway when mcp_gateway is configured.
- [ ] #4 Tests cover valid config, unknown backend keys, invalid locality, and the singleton profile grant behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/config.ts types/schema/default config parsing. Use existing zod/yaml stack; no new parser. Keep top-level mcp_servers empty/legacy-only and represent upstreams under mcp_gateway, not profile mcp_servers.
<!-- SECTION:PLAN:END -->
