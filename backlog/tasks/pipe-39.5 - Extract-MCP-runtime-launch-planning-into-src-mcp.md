---
id: PIPE-39.5
title: Extract MCP runtime launch planning into src/mcp
status: Done
assignee: []
created_date: '2026-06-02 16:34'
updated_date: '2026-06-02 20:46'
labels:
  - mcp
  - runtime
  - opencode
  - codex
dependencies:
  - PIPE-39.4
references:
  - src/runner.ts
  - tests/runner.test.ts
modified_files:
  - src/mcp/launch-plan.ts
  - src/mcp/host-renderers.ts
  - src/runner.ts
  - tests/runner.test.ts
parent_task_id: PIPE-39
priority: high
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move profile MCP server selection and host-specific runtime launch rendering out of src/runner.ts into the dedicated MCP module. This is a behavior-preserving extraction so later isolation and gateway policy can change one module instead of scattered helpers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 src/runner.ts no longer defines selectedMcpServers, mcpArgsFor, toClaudeMcpConfig, toKimiMcpConfig, toOpenCodeMcpConfig, codexMcpArgs, isRemoteMcpServer, or bearer-header rendering.
- [x] #2 A public MCP launch-plan API returns args and env for Codex, Claude, Kimi, and OpenCode from the same selected profile MCP server set.
- [x] #3 OpenCode remains first-class: the launch plan still writes the expected temporary config file or equivalent env payload and preserves existing local/remote MCP rendering.
- [x] #4 Codex, Claude, Kimi, and OpenCode tests for stdio MCP servers, imported .mcp.json refs, and remote HTTP MCP servers continue to assert the same rendered behavior.
- [x] #5 The module interface is deep enough that callers do not need to know transport-specific header, bearer token, command, args, or OpenCode temp-file details.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create src/mcp/launch-plan.ts plus host renderer files if useful. Move code from runner.ts with behavior-preserving tests first: runner tests should fail when the old helpers are removed, then pass through the new API. Keep skillArgsFor in runner.ts or a separate future skills module; this ticket is MCP-only.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented as part of PIPE-39. Verification: bun run check passed; bun run typecheck passed; bun run test passed with 279 tests passing and 15 live-runner tests skipped.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused tests or documented research evidence cover the ticket acceptance criteria.
- [x] #2 Relevant project verification command is run and its result is recorded in the task final summary.
- [x] #3 Diff is reviewed for unrelated edits, unsafe casts/assertions, disabled checks, and shallow glue before marking done.
<!-- DOD:END -->
