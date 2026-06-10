---
id: PIPE-55.3
title: Wire merged OpenCode config into installCommands
status: To Do
assignee: []
created_date: '2026-06-10 14:58'
labels: []
dependencies:
  - PIPE-55.2
references:
  - src/install-commands.ts
  - src/mcp/gateway.ts
  - .opencode/opencode.json
modified_files:
  - src/install-commands.ts
  - tests/install-commands.test.ts
  - .opencode/opencode.json
parent_task_id: PIPE-55
priority: high
ordinal: 175000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Use the OpenCode config merge contract when installing .opencode/opencode.json so package defaults are added without destroying existing repo-local auth plugin or gateway settings.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 installCommands routes only .opencode/opencode.json through the merge helper when an existing file is present.
- [ ] #2 pipe init updates stale package plugin projection and adds oc-codex-multi-auth without dropping user plugin entries.
- [ ] #3 Existing project mcp.pipeline-gateway values survive pipe init unchanged.
- [ ] #4 pipe mcp gateway configure-host remains the explicit rewrite path for gateway repair and still creates backups.
- [ ] #5 The tracked/generated .opencode/opencode.json includes the current package defaults including oc-codex-multi-auth.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Refactor renderOpenCodeProjectConfig or the CommandDefinition write path so OpenCode config generation produces a package projection and merges it against current file contents. Keep command, agent, skill, and local plugin file installation unchanged. Update tests from PIPE-55.1 as needed to pass.
<!-- SECTION:PLAN:END -->
