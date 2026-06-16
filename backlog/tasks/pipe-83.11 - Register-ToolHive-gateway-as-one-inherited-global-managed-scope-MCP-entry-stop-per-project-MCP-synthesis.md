---
id: PIPE-83.11
title: >-
  Register ToolHive gateway as one inherited global/managed-scope MCP entry;
  stop per-project MCP synthesis
status: To Do
assignee: []
created_date: '2026-06-15 17:36'
labels:
  - standardization
  - mcp
dependencies: []
references:
  - src/mcp/gateway.ts
  - src/install-commands/opencode.ts
  - defaults/profiles.yaml
parent_task_id: PIPE-83
priority: high
ordinal: 229000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream E (standardization — the original ask: don't reconfigure every repo). Harness research confirms every harness supports a single machine/user/org-scoped MCP entry all projects inherit (Goose global config, Claude Code managed scope, opencode well-known), and that the centralized gateway is the right design (Claude Code/Roo user-scope MCP is buggy — #16728 — which JUSTIFIES keeping ToolHive rather than going native-MCP).

Register pipeline-gateway (ToolHive) ONCE at global/managed scope so every repo inherits it; stop synthesizing per-project MCP entries in moka init / install-commands. Bonus: sidesteps the many-MCP context-bloat tax.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-gateway is registered once at a global/user/managed scope that all projects inherit, with the path documented per harness
- [ ] #2 moka init / install-commands no longer synthesize per-project MCP entries (or write only a thin inherit-reference)
- [ ] #3 A fresh repo has working MCP with zero per-project MCP setup
- [ ] #4 Docs explain why the gateway stays (user-scope MCP brokenness, context-bloat tax)
<!-- AC:END -->
