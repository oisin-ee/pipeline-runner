---
id: PIPE-39.4
title: Move MCP bootstrap and default registration into src/mcp
status: Done
assignee: []
created_date: '2026-06-02 16:33'
updated_date: '2026-06-02 20:46'
labels:
  - mcp
  - init
dependencies: []
references:
  - src/pipeline-init.ts
  - defaults/install-manifest.json
  - tests/pipeline-init.test.ts
  - tests/cli.test.ts
modified_files:
  - src/mcp/bootstrap.ts
  - src/mcp/index.ts
  - src/pipeline-init.ts
  - tests/pipeline-init.test.ts
  - tests/cli.test.ts
parent_task_id: PIPE-39
priority: high
ordinal: 68000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the dedicated MCP module boundary by moving default MCP install manifest types, MCPM argument construction, credential resolution, skip/redaction behavior, and default .mcp.json generation out of pipeline-init.ts. pipeline-init.ts should orchestrate init, not own MCP internals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A src/mcp entry point exists and exports the MCP bootstrap/install API used by initPipelineProject.
- [x] #2 PipelineMcpInstallSpec, header credential types, skipped-registration types, installDefaultMcpsWithCli, mcpInstallArgs behavior, and redaction behavior are owned by files under src/mcp.
- [x] #3 pipeline-init.ts no longer contains MCPM command construction, MCP credential resolution, MCP install redaction, or defaultMcpJson internals.
- [x] #4 Existing init tests for MCPM registration, optional Qdrant skip behavior, manifest loading, and credential redaction still pass with minimal assertion updates.
- [x] #5 No runtime launch behavior changes in this ticket: runner.ts MCP args/env remain as they were until the launch-plan ticket.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create src/mcp/bootstrap.ts and src/mcp/index.ts. Move the MCP-specific init types/functions from src/pipeline-init.ts into that module, keep public names stable where tests/imports already use them, and have pipeline-init.ts import them. Keep defaults/install-manifest.json as data input for now.
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
