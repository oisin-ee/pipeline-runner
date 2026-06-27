---
id: PIPE-45.5
title: Split MCP gateway pure renderers from IO
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/mcp/gateway.ts
modified_files:
  - src/mcp/gateway.ts
  - tests/mcp-repo-local-backends.test.ts
  - tests/mcp-toolhive-vmcp.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 300000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/mcp/gateway.ts into pure renderers, host adapters, reconcile IO, and CLI/service facade.
Dependencies: PIPE-45.1
Likely modified files: src/mcp/gateway.ts, src/mcp/hosts/*, src/mcp/renderers.ts, tests/mcp-*.test.ts
Reuse: existing JSON/YAML tooling and gateway conventions; no new renderer framework.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Pure MCP config rendering is testable without filesystem/process IO -- Evidence: focused renderer tests.
- [ ] #2 Host-specific MCP rules live behind host modules -- Evidence: source inspection.
- [ ] #3 Gateway behaviour remains compatible -- Evidence: existing MCP tests pass.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
