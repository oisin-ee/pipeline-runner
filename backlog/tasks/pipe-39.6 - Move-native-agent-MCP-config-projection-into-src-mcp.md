---
id: PIPE-39.6
title: Move native agent MCP config projection into src/mcp
status: Done
assignee: []
created_date: '2026-06-02 16:34'
updated_date: '2026-06-02 20:46'
labels:
  - mcp
  - install-commands
  - codex
  - opencode
dependencies:
  - PIPE-39.5
references:
  - src/install-commands.ts
  - tests/dogfood-installed.test.ts
  - tests/cli.test.ts
modified_files:
  - src/mcp/native-config.ts
  - src/install-commands.ts
  - tests/dogfood-installed.test.ts
  - tests/cli.test.ts
parent_task_id: PIPE-39
priority: high
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move generated native-agent MCP configuration out of install-commands.ts and into the MCP module, reusing the same server-selection and rendering concepts as runtime launch planning. Codex native agent TOML is currently the concrete generated MCP config; OpenCode behavior must be explicitly represented rather than forgotten.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 install-commands.ts no longer defines codexAgentMcpConfig or codexAgentMcpServerConfig.
- [x] #2 src/mcp exposes a native-agent MCP projection API used by install-commands.ts for generated Codex agent TOML.
- [x] #3 Generated Codex .codex/agents/*.toml still includes exactly the profile-selected MCP servers with correct stdio and remote fields.
- [x] #4 OpenCode generated agent handling is documented in code/tests: either no static MCP projection is needed because runtime launch env owns it, or an OpenCode-native projection is added if supported by the host research.
- [x] #5 dogfood-installed and install-command tests verify MCP grants still appear in generated resources and no profile receives unselected MCP servers.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
After PIPE-39.5 creates shared MCP selection/rendering, add src/mcp/native-config.ts. Replace install-commands.ts MCP-specific helpers with a call into that module. Keep generated command and skill logic in install-commands.ts; do not move unrelated host generation.
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
