---
id: PIPE-19.8
title: "Implement explicit skills, MCP servers, rules, and tool capability grants"
status: Done
assignee: []
created_date: "2026-05-24 14:17"
updated_date: "2026-05-25 09:44"
labels:
  - pipeline
  - capabilities
  - mcp
  - skills
dependencies:
  - PIPE-19.1
  - PIPE-19.5
references:
  - src/mastra/runner.ts
  - src/install-commands.ts
modified_files:
  - src/mastra/config.ts
  - src/mastra/runner.ts
  - src/install-commands.ts
  - tests/config.test.ts
  - tests/runner.test.ts
  - tests/install-commands.test.ts
parent_task_id: PIPE-19
priority: high
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Implement the top-level registries and per-agent grants for rules, skills, MCP servers, tools, filesystem, and network policies. This replaces profile magic with explicit capability declarations that can be validated and projected into each host runner as far as that host supports them.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Top-level `rules`, `skills`, and `mcp_servers` declarations can be referenced by agents and workflows.
- [x] #2 Agents can allow only the rules, skills, MCP servers, and tools they need.
- [x] #3 Validation fails when an agent references an undeclared rule, skill, or MCP server.
- [x] #4 Capability projection handles host differences without silently granting broader access than requested.
- [x] #5 Tests cover allowed, denied, missing, and unsupported capability cases.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Validated top-level rules, skills, MCP servers, tools, filesystem, network, and output capabilities as explicit per-agent grants, then projected those grants into host resources without widening access.

<!-- SECTION:FINAL_SUMMARY:END -->
