---
id: PIPE-55.4
title: Verify real repo-local OpenCode behavior
status: To Do
assignee: []
created_date: '2026-06-10 14:59'
labels: []
dependencies:
  - PIPE-55.3
references:
  - tests/install-commands.test.ts
  - tests/opencode-project-config.test.ts
modified_files:
  - tests/install-commands.test.ts
parent_task_id: PIPE-55
priority: high
ordinal: 176000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Run focused tests and real command-line checks against a temporary repo to prove the fix works through the same paths users exercise.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 bun test tests/opencode-project-config.test.ts tests/install-commands.test.ts passes.
- [ ] #2 bun run build passes.
- [ ] #3 A real temp-repo pipe init or built CLI init preserves pre-existing OpenCode plugin and MCP entries.
- [ ] #4 When opencode is installed, opencode debug config for the temp repo shows oc-codex-multi-auth and pipeline-gateway in the resolved config.
- [ ] #5 If opencode is unavailable, the verification notes say that CLI-resolved config verification was not run.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the built package command surface rather than only unit tests. Prefer a temp directory fixture with an existing .opencode/opencode.json, then run the repo CLI init path and inspect both the file and opencode debug config.
<!-- SECTION:PLAN:END -->
