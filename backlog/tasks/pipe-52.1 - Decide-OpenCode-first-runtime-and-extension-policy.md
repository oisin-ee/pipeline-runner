---
id: PIPE-52.1
title: Decide OpenCode-first runtime and extension policy
status: Done
assignee: []
created_date: "2026-06-08 19:00"
updated_date: "2026-06-08 19:27"
labels:
  - opencode
  - adr
dependencies: []
references:
  - "https://opencode.ai/docs/plugins"
  - "https://opencode.ai/docs/agents"
  - "https://opencode.ai/docs/skills/"
  - "https://opencode.ai/docs/mcp-servers"
  - "https://opencode.ai/docs/lsp/"
modified_files:
  - docs/adr-opencode-first-goal-loop-runtime.md
parent_task_id: PIPE-52
priority: high
ordinal: 146000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Write the architecture decision for making OpenCode the default runtime and defining the curated package-owned OpenCode stack. The default should be cohesive and batteries-included.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 ADR states OpenCode is default for built-in profiles and runner-job orchestrator selection, with Codex kept as compatibility runner.
- [ ] #2 ADR distinguishes package-owned defaults, hard dependencies, and included ecosystem code, including DCP code.
- [ ] #3 ADR states pipeline-owned schedule/gate/goal state remains the source of truth; OpenCode plugin session state is never the authoritative workflow state.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Create docs/adr-opencode-first-goal-loop-runtime.md or equivalent. Cite official OpenCode docs for agents, plugins, skills, MCP, LSP, and ecosystem. Include library-first vetting table for @opencode-ai/plugin, @opencode-ai/sdk, opencode-handoff, DCP code, @devtheops/opencode-plugin-otel, opencode-snip, opencode-background-agents, opencode-mem, and cupcake.

<!-- SECTION:PLAN:END -->
