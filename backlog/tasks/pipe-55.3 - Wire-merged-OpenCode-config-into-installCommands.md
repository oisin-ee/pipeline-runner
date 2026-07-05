---
id: PIPE-55.3
title: Wire merged OpenCode config into installCommands
status: Done
assignee: []
created_date: "2026-06-10 14:58"
updated_date: "2026-07-04 19:42"
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

Use the OpenCode config merge contract when installing .opencode/opencode.json so package defaults are added without destroying existing repo-local plugin or gateway settings.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 installCommands routes only .opencode/opencode.json through the merge helper when an existing file is present.
- [x] #2 pipe init updates stale package plugin projection without adding oc-codex-multi-auth or dropping user plugin entries.
- [x] #3 Existing project mcp.pipeline-gateway values survive pipe init unchanged.
- [x] #4 pipe mcp gateway configure-host remains the explicit rewrite path for gateway repair and still creates backups.
- [x] #5 The tracked/generated .opencode/opencode.json includes current package defaults and excludes oc-codex-multi-auth.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Refactor renderOpenCodeProjectConfig or the CommandDefinition write path so OpenCode config generation produces a package projection and merges it against current file contents. Keep command, agent, skill, and local plugin file installation unchanged. Update tests from PIPE-55.1 as needed to pass.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented. The opencode HostAdapter routes only `.opencode/opencode.json` (OPENCODE_PROJECT_CONFIG_PATH, src/install-commands/shared.ts:15) through the merge helper: `mergeDefinition` returns undefined for every other path and calls `mergeOpenCodeProjectConfig(existingContent, projection)` when the project-config file is present (src/install-commands/opencode.ts:654-670, `isAlwaysForced` scopes forcing to that one path) — AC1. AC2/AC3: proven by tests/install-commands.test.ts:330 (existing plugin + gateway preserved, defaults projected, no oc-codex). AC4: `moka mcp gateway configure-host` remains the explicit host-config rewrite with backup — src/cli/mcp-gateway-commands.ts:62, backup via `backupIfExists` → `.bak-<ts>` in src/mcp/host-config.ts:127-133. AC5: generated `.opencode/opencode.json` asserted to carry current defaults (lsp true, otel + goal plugins) and no provider/oc-codex at tests/install-commands.test.ts:174-184. Landed commit 4406960; gateway ownership later split in 5732c6e. Note: tracked repo-root `.opencode/opencode.json` no longer exists — the file is generated into target repos at init, which is what the merge/tests exercise. Not superseded by the chezmoi harness reframe (750306e): the merge remains the live init path at HEAD.

<!-- SECTION:FINAL_SUMMARY:END -->
