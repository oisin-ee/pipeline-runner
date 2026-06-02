---
id: PIPE-39.7
title: Implement profile-scoped MCP isolation policy
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
  - PIPE-39.1
  - PIPE-39.6
references:
  - docs/mcp-host-isolation.md
  - src/mcp/launch-plan.ts
  - src/runner.ts
  - tests/runner.test.ts
modified_files:
  - src/mcp/launch-plan.ts
  - src/mcp/host-renderers.ts
  - src/runner.ts
  - tests/runner.test.ts
  - docs/mcp-host-isolation.md
parent_task_id: PIPE-39
priority: high
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Use the researched host behavior to prevent the MCP fan-out problem: each agent should receive only the MCP servers selected by its profile whenever the host allows that. This ticket changes policy after the MCP module exists, with Codex and OpenCode handled as peers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Codex runtime launch uses the researched isolation strategy, including --ignore-user-config when supported and safe, while still passing required model, skills, MCP servers, approval, sandbox, and worktree arguments explicitly.
- [x] #2 OpenCode runtime launch uses the researched isolation strategy for MCP config layering. If OpenCode cannot fully ignore global config, the implementation documents that limitation and prevents known configured pipeline MCP leakage where possible.
- [x] #3 Tests prove an agent with mcp_servers: [docs] receives docs and does not receive another declared pipeline MCP server such as github-readonly.
- [x] #4 Tests cover both local stdio and remote HTTP MCP entries under the isolation policy for Codex and OpenCode.
- [x] #5 The policy is implemented in src/mcp, not as host-specific conditionals scattered through runner.ts.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Start from docs/mcp-host-isolation.md from PIPE-39.1. Add tests that fail with global/pipeline MCP leakage at the launch-plan seam. Implement Codex/OpenCode isolation inside src/mcp launch planning; keep unsupported host limitations explicit in docs and test names.
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
