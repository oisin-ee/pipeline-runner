---
id: PIPE-52.7
title: Project OpenCode agents skills prompts permissions and LSP
status: Done
assignee: []
created_date: "2026-06-08 19:01"
updated_date: "2026-06-08 20:12"
labels:
  - opencode
  - host-resources
dependencies:
  - PIPE-52.2
references:
  - "https://opencode.ai/docs/agents"
  - "https://opencode.ai/docs/skills/"
  - "https://opencode.ai/docs/commands"
  - "https://opencode.ai/docs/lsp/"
modified_files:
  - src/install-commands.ts
  - docs/slash-command-adapter-contract.md
  - docs/config-architecture.md
parent_task_id: PIPE-52
priority: high
ordinal: 152000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Upgrade generated OpenCode host resources so package profiles become native OpenCode agents with correct prompts, skill permissions, task permissions, MCP grants, and LSP settings.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Generated .opencode agents use OpenCode markdown/frontmatter fields for mode, description, model, prompt, permissions, hidden status, and task permissions where applicable.
- [ ] #2 Pipeline skills are visible through OpenCode native skill discovery or generated .opencode skill projection, with per-agent skill permission rules.
- [ ] #3 Generated OpenCode command surfaces preserve pipeline entrypoints and dispatch exact package-configured profiles.
- [ ] #4 OpenCode LSP is surfaced in generated host settings with docs explaining when CLI lint/typecheck remains preferred.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Use official OpenCode docs for agents, skills, permissions, commands, and LSP. Update install-commands host adapter output and generated-defaults audit. Do not add global user config writes; project host resources remain package-owned and idempotent.

<!-- SECTION:PLAN:END -->
