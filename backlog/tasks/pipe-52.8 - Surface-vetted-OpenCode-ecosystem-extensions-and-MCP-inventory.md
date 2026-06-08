---
id: PIPE-52.8
title: Surface vetted OpenCode ecosystem extensions and MCP inventory
status: Done
assignee: []
created_date: '2026-06-08 19:01'
updated_date: '2026-06-08 19:35'
labels:
  - ecosystem
  - mcp
  - plugins
dependencies:
  - PIPE-52.1
references:
  - 'https://github.com/awesome-opencode/awesome-opencode'
  - 'https://www.opencode.cafe/'
  - 'https://opencode.ai/docs/ecosystem'
  - docs/mcp-gateway.md
modified_files:
  - defaults/opencode-ecosystem.yaml
  - src/config.ts
  - src/mcp/gateway.ts
parent_task_id: PIPE-52
priority: high
ordinal: 153000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create a package-owned ecosystem manifest that defines the curated default OpenCode stack: plugins, DCP code, MCP servers, skills, prompts, and host capabilities that pipeline should generate and use by default.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Manifest records official hard dependencies @opencode-ai/plugin and @opencode-ai/sdk as development/reference dependencies only when needed by package code.
- [ ] #2 Manifest includes opencode-background-agents, opencode-handoff, opencode-plugin-otel, opencode-snip, opencode-mem, cupcake, and DCP code as required default stack contents.
- [ ] #3 Manifest surfaces MCP backends relevant to pipeline profiles: pipeline-gateway, Context7, uidotsh, Qdrant, Fallow, Serena, Backlog, GitHub, Playwright/browser, and Neon, with locality and credential requirements.
- [ ] #4 Manifest surfaces profile skills and prompts so generated OpenCode agents can see which package skills/prompts they are expected to use.
- [ ] #5 The default stack includes the selected OpenCode ecosystem capabilities directly.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add defaults/opencode-ecosystem.yaml or equivalent plus parser/validation if needed. Use official docs, awesome-opencode, opencode.cafe, npm view results, and GitHub README evidence. Prefer one curated deterministic default stack over user-facing choice sprawl.
<!-- SECTION:PLAN:END -->
