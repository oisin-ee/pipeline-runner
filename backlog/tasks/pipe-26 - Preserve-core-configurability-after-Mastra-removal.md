---
id: PIPE-26
title: Preserve core configurability after Mastra removal
status: Done
assignee: []
created_date: "2026-05-25 20:02"
updated_date: "2026-05-25 20:32"
labels:
  - config
  - architecture
  - compatibility
dependencies:
  - PIPE-25
  - PIPE-23
  - PIPE-22
priority: high
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

After the Mastra cleanup, prove that the config-driven runtime still supports the project-level customization points that motivated the redesign. Removing Mastra must not accidentally remove or weaken configured skills, MCP servers, hooks, rules, tools, filesystem/network grants, or runner capabilities.

This task is a regression guard and documentation pass. The pipeline core should validate and pass through configured capabilities, but it must not require any particular skill, MCP server, hook, task system, runner, or external tool. Project config remains the place where those choices are made.

Scope:

- Validate schemas still support registries for `rules`, `skills`, and `mcp_servers`.
- Validate profiles can still request `rules`, `skills`, `mcp_servers`, `tools`, `filesystem`, and `network` grants.
- Validate hooks remain configurable at workflow, orchestrator, and node levels after PIPE-23/PIPE-22.
- Validate generated host resources still project configured grants to host-specific files.
- Update docs to describe core flow control versus project-configured tools.

Non-goals:

- Do not add new tool integrations.
- Do not make skills, MCP servers, or hooks mandatory.
- Do not implement acceptance gates or task-context resolvers here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Config schema still supports skills, MCP servers, rules, hooks, tools, filesystem, network, and runner capability grants.
- [x] #2 Runtime still loads configured rules, skills, and MCP references into agent boundaries.
- [x] #3 Runtime still dispatches configured workflow, orchestrator, and node hooks.
- [x] #4 No skill, MCP server, hook, or external tool is required by default core execution.
- [x] #5 Documentation distinguishes core flow control from project-configured tools.
- [x] #6 Generated host resources still include configured profile grants where the host supports them.
- [x] #7 Existing dogfood config validates and runs.
- [x] #8 Tests cover the absence of optional registries so minimal projects do not need skills, MCP servers, or hooks.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Audit `src/config.ts`, runtime prompt rendering, and install-command generation after PIPE-25 path moves.
2. Add/adjust tests that parse a config with rules, skills, MCP servers, hooks, tool grants, filesystem grants, and network grants.
3. Add/adjust runtime tests proving configured rules/skills/MCP content reaches agent prompts without being required globally.
4. Add/adjust hook tests after PIPE-23 and PIPE-22 so workflow, orchestrator, and node hooks are all covered according to documented semantics.
5. Add/adjust install-command tests proving generated host resources preserve configured profile grants.
6. Update docs with explicit boundary language: core controls flow; project config controls tools and integrations.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Preserved config-driven rules, skills, MCP servers, grants, hooks, generated host projections, minimal optional registry behavior, dogfood validation/run, and documentation that separates core flow control from project-configured integrations.

<!-- SECTION:FINAL_SUMMARY:END -->
