---
id: PIPE-55.1
title: Reproduce OpenCode local config auth and gateway preservation
status: To Do
assignee: []
created_date: '2026-06-10 14:58'
labels: []
dependencies: []
references:
  - tests/install-commands.test.ts
  - src/install-commands.ts
modified_files:
  - tests/install-commands.test.ts
parent_task_id: PIPE-55
priority: high
ordinal: 173000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the deterministic bug feedback loop for repo-local OpenCode config. The fixture must start with an existing .opencode/opencode.json containing user plugin and MCP entries, run the same install path that pipe init uses, and assert those entries are not lost while package defaults are projected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A failing regression test demonstrates that existing repo-local plugin entries are dropped or stale before the fix.
- [ ] #2 The test asserts current package plugin defaults are present after installation and oc-codex-multi-auth is absent.
- [ ] #3 The test asserts an existing repo-local mcp.pipeline-gateway object is preserved by installCommands or initPipelineProject and is not rewritten except by the explicit gateway configure-host command.
- [ ] #4 The test seam uses installCommands or initPipelineProject directly; it must not mock the merge result.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a focused test in tests/install-commands.test.ts or a new installer-focused test file. Use temp directories and real JSON file contents. Keep the test scoped to installer behavior; OpenCode CLI integration belongs to PIPE-55.4.
<!-- SECTION:PLAN:END -->
