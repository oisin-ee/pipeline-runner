---
id: PIPE-55.5
title: Document OpenCode config ownership and repair flow
status: Done
assignee: []
created_date: '2026-06-10 14:59'
updated_date: '2026-07-04 19:43'
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
- [x] #1 Docs state pipe init preserves existing OpenCode plugin entries while adding missing package defaults.
- [x] #2 Docs state pipe mcp gateway configure-host rewrites host MCP config and backs up the prior file.
- [x] #3 Docs state PIPELINE_MCP_GATEWAY_AUTHORIZATION is required for the hosted gateway.
- [x] #4 Docs state OpenCode must be restarted after config changes because config is loaded at startup.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update docs/mcp-gateway.md and docs/operator-guide.md. Keep docs factual and command-oriented; do not add an ADR unless the implementation changes the ownership model instead of preserving it.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented in both operator docs. docs/operator-guide.md:504-512 and docs/mcp-gateway.md:98-123 state: AC1 — `moka init` preserves existing OpenCode plugin entries while appending missing package defaults, and an existing `mcp.pipeline-gateway` entry is preserved; AC2 — `moka mcp gateway configure-host` is the explicit migration/repair rewrite that backs up the prior host config; AC3 — the hosted gateway requires `PIPELINE_MCP_GATEWAY_AUTHORIZATION` in the OpenCode environment; AC4 — restart OpenCode after config changes because it loads config at startup (operator-guide.md:511-512). Docs use the current `moka` command surface. No ADR added, per plan (ownership model preserved, not changed). Landed commit 4406960 (PIPE-55).
<!-- SECTION:FINAL_SUMMARY:END -->
