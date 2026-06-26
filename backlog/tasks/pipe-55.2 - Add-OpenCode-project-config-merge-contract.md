---
id: PIPE-55.2
title: Add OpenCode project config merge contract
status: To Do
assignee: []
created_date: '2026-06-10 14:58'
labels: []
dependencies: []
references:
  - src/install-commands.ts
  - defaults/opencode-ecosystem.yaml
modified_files:
  - package.json
  - bun.lock
  - src/opencode-project-config.ts
  - tests/opencode-project-config.test.ts
parent_task_id: PIPE-55
priority: high
ordinal: 174000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce a pure OpenCode project config merge module that preserves existing project config while adding missing package-owned defaults. This is the shared contract for installer wiring and should be implementation-complete before installCommands changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Adds jsonc-parser as the JSONC parsing/editing dependency and updates the lockfile through the project package manager.
- [ ] #2 A pure merge function preserves existing plugin entries and appends missing package defaults without adding oc-codex-multi-auth.
- [ ] #3 The merge function preserves an existing mcp.pipeline-gateway object exactly when present.
- [ ] #4 The merge function creates package mcp.pipeline-gateway only when absent.
- [ ] #5 The merge function defaults lsp to true only when lsp is absent.
- [ ] #6 Invalid JSON or JSONC reports a typed conflict/result and does not silently overwrite user config.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create src/opencode-project-config.ts with a small public function such as mergeOpenCodeProjectConfig(existingText, packageProjection). Use jsonc-parser rather than regex/string slicing. Add tests in tests/opencode-project-config.test.ts covering plugins, MCP preservation, absent defaults, lsp preservation, comments/trailing commas, and invalid config.
<!-- SECTION:PLAN:END -->
