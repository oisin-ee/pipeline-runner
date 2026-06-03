---
id: PIPE-19.5
title: Build typed runner adapters plus command runner escape hatch
status: Done
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-25 09:44'
labels:
  - pipeline
  - runner
  - adapters
dependencies:
  - PIPE-19.1
references:
  - src/mastra/runner.ts
  - src/index.ts
modified_files:
  - src/mastra/runner.ts
  - tests/runner.test.ts
parent_task_id: PIPE-19
priority: high
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the runner abstraction used by agent nodes. Built-in runner adapters should cover Codex, Codex, OpenCode, Kimi, and Pi with typed fields for model, reasoning/thinking, sandbox/permissions, cwd, env, output mode, and timeout. A `command` runner should support arbitrary CLIs only when capabilities and output behavior are declared explicitly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runner validation rejects unknown built-in runners and unsupported capability combinations before execution.
- [x] #2 Built-in runner adapters can produce deterministic launch plans without calling external model services in tests.
- [x] #3 The command runner supports argv-style commands and declares its capabilities explicitly.
- [x] #4 Runner output contracts can support plain text, JSON, JSONL/streaming JSON, and schema-validated structured output where available.
- [x] #5 Tests cover Codex, Codex, OpenCode, Kimi, Pi, and command runner launch planning.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added typed launch planning for Codex, Codex, OpenCode, Kimi, Pi, and command runners with explicit output capability validation and deterministic tests.
<!-- SECTION:FINAL_SUMMARY:END -->
