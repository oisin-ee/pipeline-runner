---
id: PIPE-55.5
title: Document OpenCode config ownership and repair flow
status: To Do
assignee: []
created_date: '2026-06-10 14:59'
labels: []
dependencies:
  - PIPE-55.3
references:
  - docs/mcp-gateway.md
  - docs/operator-guide.md
modified_files:
  - docs/mcp-gateway.md
  - docs/operator-guide.md
parent_task_id: PIPE-55
priority: medium
ordinal: 177000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update operator-facing docs to explain that pipe init merges OpenCode project config, while gateway configure-host is the explicit rewrite and backup path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docs state pipe init preserves existing OpenCode plugin entries while adding missing package defaults.
- [ ] #2 Docs state pipe mcp gateway configure-host rewrites host MCP config and backs up the prior file.
- [ ] #3 Docs state PIPELINE_MCP_GATEWAY_AUTHORIZATION is required for the hosted gateway.
- [ ] #4 Docs state OpenCode must be restarted after config changes because config is loaded at startup.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update docs/mcp-gateway.md and docs/operator-guide.md. Keep docs factual and command-oriented; do not add an ADR unless the implementation changes the ownership model instead of preserving it.
<!-- SECTION:PLAN:END -->
