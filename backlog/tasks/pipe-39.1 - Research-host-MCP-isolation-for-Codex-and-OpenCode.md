---
id: PIPE-39.1
title: Research host MCP isolation for Codex and OpenCode
status: Done
assignee: []
created_date: '2026-06-02 16:33'
updated_date: '2026-06-02 20:46'
labels:
  - mcp
  - research
  - opencode
  - codex
dependencies: []
references:
  - src/runner.ts
  - tests/runner.test.ts
modified_files:
  - docs/mcp-host-isolation.md
parent_task_id: PIPE-39
priority: high
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Determine the exact current host behavior for profile-scoped MCP config. This is a planning prerequisite for the isolation policy: Codex and OpenCode have different config layering behavior, and the implementation must not guess.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Records current Codex CLI behavior for user config loading, --config MCP overrides, and any ignore-user-config/isolation flag using local CLI help and official docs.
- [x] #2 Records current OpenCode config layering behavior for OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT, global/project config merge order, and MCP enable/disable semantics using official docs or local CLI help.
- [x] #3 Produces a concrete recommended launch policy for Codex and OpenCode: exact args/env/config shape, what globals are prevented, and what cannot be prevented without upstream support.
- [x] #4 Adds the evidence and recommendation to a repo-local doc or task notes that later implementation tickets can cite.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect codex/opencode local CLI help and official docs. Do not change runtime code. Write the resulting policy in docs/mcp-host-isolation.md or equivalent task notes, including implications for tests.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented as part of PIPE-39. Verification: bun run check passed; bun run typecheck passed; bun run test passed with 277 tests passing and 15 live-runner tests skipped.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused tests or documented research evidence cover the ticket acceptance criteria.
- [x] #2 Relevant project verification command is run and its result is recorded in the task final summary.
- [x] #3 Diff is reviewed for unrelated edits, unsafe casts/assertions, disabled checks, and shallow glue before marking done.
<!-- DOD:END -->
