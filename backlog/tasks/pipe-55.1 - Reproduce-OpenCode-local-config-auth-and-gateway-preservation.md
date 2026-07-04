---
id: PIPE-55.1
title: Reproduce OpenCode local config auth and gateway preservation
status: Done
assignee: []
created_date: '2026-06-10 14:58'
updated_date: '2026-07-04 19:42'
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
- [x] #1 A failing regression test demonstrates that existing repo-local plugin entries are dropped or stale before the fix.
- [x] #2 The test asserts current package plugin defaults are present after installation and oc-codex-multi-auth is absent.
- [x] #3 The test asserts an existing repo-local mcp.pipeline-gateway object is preserved by installCommands or initPipelineProject and is not rewritten except by the explicit gateway configure-host command.
- [x] #4 The test seam uses installCommands or initPipelineProject directly; it must not mock the merge result.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a focused test in tests/install-commands.test.ts or a new installer-focused test file. Use temp directories and real JSON file contents. Keep the test scoped to installer behavior; OpenCode CLI integration belongs to PIPE-55.4.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented. Regression test `it("preserves repo-local OpenCode auth plugin and gateway config")` in tests/install-commands.test.ts:330. Seeds a temp repo with an existing `.opencode/opencode.json` containing a local auth plugin plus an `mcp.pipeline-gateway` object (lines 332-360), runs the real installer path (installCommands via the opencode HostAdapter — no mocked merge, AC4), then asserts: the user plugin survives and current package plugin defaults are present with oc-codex-multi-auth absent (AC1/AC2), and `opencode.mcp["pipeline-gateway"]` equals the pre-existing object exactly (line 373, AC3). Landed commit 4406960 (PIPE-55). Note: ticket text says `pipe init`; current CLI surface is `moka` (stale term, no behavioural impact).
<!-- SECTION:FINAL_SUMMARY:END -->
