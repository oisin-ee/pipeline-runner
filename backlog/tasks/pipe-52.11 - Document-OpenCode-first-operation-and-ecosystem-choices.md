---
id: PIPE-52.11
title: Document OpenCode-first operation and ecosystem choices
status: Done
assignee: []
created_date: '2026-06-08 19:02'
labels:
  - docs
  - opencode
dependencies:
  - PIPE-52.7
  - PIPE-52.8
  - PIPE-52.9
  - PIPE-52.10
references:
  - README.md
  - docs/operator-guide.md
  - docs/config-architecture.md
  - docs/mcp-gateway.md
modified_files:
  - README.md
  - docs/operator-guide.md
  - docs/config-architecture.md
  - docs/mcp-gateway.md
  - docs/adr-opencode-first-goal-loop-runtime.md
parent_task_id: PIPE-52
priority: medium
ordinal: 156000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update operator and architecture docs so users understand OpenCode-first defaults, goal loop behavior, continuation evidence, generated team graphs, DCP code, plugins, MCP gateway inventory, skills, prompts, permissions, and LSP tradeoffs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README and operator docs describe OpenCode as the default runtime and Codex as compatibility runner.
- [x] #2 Docs explain goal-state artifacts, continuation stop reasons, and verifier/acceptance evidence requirements.
- [x] #3 Docs list the default OpenCode plugins and DCP code as part of the curated default stack.
- [x] #4 Docs list MCP servers, skills, prompts, permissions, and LSP settings exposed by package-owned config.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update docs only after implementation contracts exist. Keep publishing instructions consistent with AGENTS.md: no local npm publish or direct container push.
<!-- SECTION:PLAN:END -->
