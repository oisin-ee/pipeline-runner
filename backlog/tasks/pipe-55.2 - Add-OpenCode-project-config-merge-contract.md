---
id: PIPE-55.2
title: Add OpenCode project config merge contract
status: Done
assignee: []
created_date: "2026-06-10 14:58"
updated_date: "2026-07-04 19:42"
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

- [x] #1 Adds jsonc-parser as the JSONC parsing/editing dependency and updates the lockfile through the project package manager.
- [x] #2 A pure merge function preserves existing plugin entries and appends missing package defaults without adding oc-codex-multi-auth.
- [x] #3 The merge function preserves an existing mcp.pipeline-gateway object exactly when present.
- [x] #4 The merge function creates package mcp.pipeline-gateway only when absent.
- [x] #5 The merge function defaults lsp to true only when lsp is absent.
- [x] #6 Invalid JSON or JSONC reports a typed conflict/result and does not silently overwrite user config.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Create src/opencode-project-config.ts with a small public function such as mergeOpenCodeProjectConfig(existingText, packageProjection). Use jsonc-parser rather than regex/string slicing. Add tests in tests/opencode-project-config.test.ts covering plugins, MCP preservation, absent defaults, lsp preservation, comments/trailing commas, and invalid config.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented. `src/opencode-project-config.ts` exports pure `mergeOpenCodeProjectConfig(currentText, projection)` returning a typed discriminated result `{ok:true, content} | {ok:false, errors: ParseError[]}` (opencode-project-config.ts:22-45). AC1: `jsonc-parser ^3.3.1` in package.json; merge uses jsonc-parser via `src/json-config-merge.ts` (applyJsonEdit/parseJsonRecord/setIfMissing), no regex slicing. AC2: `mergePluginEntries` (line 116) preserves existing plugins by name-key and appends only missing projected defaults; defaults carry no oc-codex-multi-auth (defaults/opencode-ecosystem.yaml has none). AC3/AC4: `applyMcpProjection` uses `setIfMissing(["mcp", name])` so an existing `mcp.pipeline-gateway` is preserved exactly and package gateway is only created when absent. AC5: `setIfMissing(["lsp"], projection.lsp)` defaults lsp only when absent. AC6: invalid JSONC → `parseJsonRecord` returns `{ok:false, errors}`, never overwrites. Tests: tests/opencode-project-config.test.ts (7 cases: plugin preserve+append, pinned-version replace, gateway exact-preserve, schema/lsp/gateway add-when-missing, provider models, JSONC comments, invalid-JSONC conflict). Landed commit 4406960 (PIPE-55); module last refactored 5732c6e.

<!-- SECTION:FINAL_SUMMARY:END -->
