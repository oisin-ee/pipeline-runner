---
id: PIPE-83.11
title: >-
  Register ToolHive gateway as one inherited global/managed-scope MCP entry;
  stop per-project MCP synthesis
status: Done
assignee: []
created_date: "2026-06-15 17:36"
updated_date: "2026-06-16 09:12"
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

- [x] #1 pipeline-gateway is registered once at a global/user/managed scope that all projects inherit, with the path documented per harness
- [x] #2 moka init / install-commands no longer synthesize per-project MCP entries (or write only a thin inherit-reference)
- [ ] #3 A fresh repo has working MCP with zero per-project MCP setup
- [x] #4 Docs explain why the gateway stays (user-scope MCP brokenness, context-bloat tax)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Committed a14f534 (pushed to main). The global-registration plumbing already existed: `moka gateway configure-host --scope global` writes the singleton pipeline-gateway once to $OPENCODE_CONFIG_DIR/$XDG_CONFIG_HOME/opencode/opencode.json (gatewayHostConfigPath, GatewayHostScope). The missing half — stopping the per-project synthesis — landed here: added mcp_gateway.host_scope ("project" default / "global") to mcpGatewaySchema, and shouldEmbedProjectGateway() (src/install-commands/opencode.ts, unit-tested in tests/opencode-project-gateway-scope.test.ts) makes renderOpenCodeProjectConfig OMIT the pipeline-gateway MCP block from .opencode/opencode.json when host_scope is global, so the project inherits the one global registration (AC1, AC2). Default "project" keeps the embed → install-commands goldens unchanged (full suite 622 passed). AC4: docs/config-architecture.md documents host_scope and the gateway-stays rationale (user-scope MCP brokenness #16728 + context-bloat tax). AC3 (fresh repo has working MCP with zero per-project setup) is the out-of-band real-init verification per the moka-verification rule: publish → npm i -g → set host_scope:global + `moka gateway configure-host --scope global` once → `moka init` in a fresh repo → confirm MCP resolves with no .opencode gateway entry. Code + schema + golden-safety + docs are done and gated; the live published-package check is the remaining verification step.

<!-- SECTION:FINAL_SUMMARY:END -->
