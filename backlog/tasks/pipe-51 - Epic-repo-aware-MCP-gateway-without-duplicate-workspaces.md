---
id: PIPE-51
title: 'Epic: repo-aware MCP gateway without duplicate workspaces'
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
labels:
  - epic
  - mcp
  - gateway
dependencies: []
references:
  - src/mcp/gateway.ts
  - src/config.ts
  - docs/mcp-gateway.md
priority: high
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make every repo-aware MCP server available through the singleton pipeline-gateway while preserving the active checkout as the only repository workspace. Agents must still see exactly one MCP server. Gateway-local and runner-job paths must bind repo-aware backends to PIPELINE_TARGET_PATH/current cwd or the already-prepared /workspace volume, never clone or mirror the repository for MCP.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Codex and OpenCode host configs still contain only pipeline-gateway.
- [ ] #2 Repo-aware backends bind to the existing checkout/workspace; no gateway code clones, mirrors, or copies the repo.
- [ ] #3 Local dev and runner-job paths can expose the required repo-aware backends through one gateway URL.
- [ ] #4 Doctor/verification fails when required gateway backends/tools are missing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deliver contract/schema first, then fan out backend inventory, repo-local backend definitions, runner-job binding, and doctor verification. Finish with docs and real repository usage verification.
<!-- SECTION:PLAN:END -->
