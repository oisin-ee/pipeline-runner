---
id: PIPE-19.8
title: 'Implement explicit skills, MCP servers, rules, and tool capability grants'
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
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
- [ ] #1 Top-level `rules`, `skills`, and `mcp_servers` declarations can be referenced by agents and workflows.
- [ ] #2 Agents can allow only the rules, skills, MCP servers, and tools they need.
- [ ] #3 Validation fails when an agent references an undeclared rule, skill, or MCP server.
- [ ] #4 Capability projection handles host differences without silently granting broader access than requested.
- [ ] #5 Tests cover allowed, denied, missing, and unsupported capability cases.
<!-- AC:END -->
