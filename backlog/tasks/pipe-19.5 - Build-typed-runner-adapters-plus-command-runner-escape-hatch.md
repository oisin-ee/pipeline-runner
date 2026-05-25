---
id: PIPE-19.5
title: Build typed runner adapters plus command runner escape hatch
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - runner
  - adapters
dependencies:
  - PIPE-19.1
references:
  - src/mastra/runner.ts
  - src/index.ts
parent_task_id: PIPE-19
priority: high
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the runner abstraction used by agent nodes. Built-in runner adapters should cover Codex, Claude, OpenCode, Kimi, and Pi with typed fields for model, reasoning/thinking, sandbox/permissions, cwd, env, output mode, and timeout. A `command` runner should support arbitrary CLIs only when capabilities and output behavior are declared explicitly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runner validation rejects unknown built-in runners and unsupported capability combinations before execution.
- [ ] #2 Built-in runner adapters can produce deterministic launch plans without calling external model services in tests.
- [ ] #3 The command runner supports argv-style commands and declares its capabilities explicitly.
- [ ] #4 Runner output contracts can support plain text, JSON, JSONL/streaming JSON, and schema-validated structured output where available.
- [ ] #5 Tests cover Codex, Claude, OpenCode, Kimi, Pi, and command runner launch planning.
<!-- AC:END -->
