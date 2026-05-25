---
id: PIPE-19.7
title: Project YAML agents into native host resource files
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - host-resources
  - multi-agent
dependencies:
  - PIPE-19.1
  - PIPE-19.5
  - PIPE-19.8
references:
  - src/install-commands.ts
  - .claude/agents
  - .codex/agents
  - .opencode/agents
  - .pi/extensions
parent_task_id: PIPE-19
priority: high
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update host resource generation so Claude, Codex, OpenCode, Kimi, and Pi resources are derived from `.pipeline/pipeline.yaml`. Generated resources should be host-specific projections of the same runner/agent/workflow definitions, not separate hand-maintained profile systems.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Claude resource generation represents configured agents, instructions, tools, MCP access, skills, and model settings as native Claude artifacts where supported.
- [ ] #2 Codex resource generation emits `.codex/agents` entries derived from YAML agents and preserves configured model, sandbox, MCP, and skills settings where supported.
- [ ] #3 OpenCode resource generation emits command and agent files using native primary/subagent modes and permissions derived from YAML.
- [ ] #4 Kimi resource generation emits agent files or launch specs that can use native subagents and model overrides.
- [ ] #5 Pi resource generation emits resources compatible with `pi-subagents` and validates that the required extension is available when Pi native multi-agent execution is requested.
<!-- AC:END -->
