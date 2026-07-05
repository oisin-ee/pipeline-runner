---
id: PIPE-45.5
title: Split MCP gateway pure renderers from IO
status: Done
assignee: []
created_date: "2026-06-27 14:03"
updated_date: "2026-06-27 15:46"
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/mcp/gateway.ts
modified_files:
  - src/mcp/gateway-config.ts
  - src/mcp/host-renderers.ts
  - src/mcp/host-config.ts
  - src/mcp/gateway-doctor.ts
  - src/mcp/gateway-reconcile.ts
  - src/mcp/gateway-runtime.ts
  - src/mcp/gateway-error.ts
  - src/cli/program.ts
  - src/install-commands.ts
  - src/install-commands/opencode.ts
  - src/runtime/agent-node/agent-node.ts
  - tests/mcp-gateway-renderers.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 300000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: Split src/mcp/gateway.ts into pure renderers, host adapters, reconcile IO, and CLI/service facade.
Dependencies: PIPE-45.1
Likely modified files: src/mcp/gateway.ts, src/mcp/hosts/_, src/mcp/renderers.ts, tests/mcp-_.test.ts
Reuse: existing JSON/YAML tooling and gateway conventions; no new renderer framework.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Pure MCP config rendering is testable without filesystem/process IO -- Evidence: focused renderer tests.
- [x] #2 Host-specific MCP rules live behind host modules -- Evidence: source inspection.
- [x] #3 Gateway behaviour remains compatible -- Evidence: existing MCP tests pass.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Split the mixed MCP gateway module into direct owner modules: pure config/profile rendering, pure host renderers, host config IO, doctor checks, ToolHive reconcile IO, and Effect provider runtime. Deleted src/mcp/gateway.ts instead of leaving aliases/facades. Added pure renderer tests and preserved existing CLI/runtime behaviour. Proof: focused MCP/install/runtime tests, typecheck, check, fallow audit, build, full test suite.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
