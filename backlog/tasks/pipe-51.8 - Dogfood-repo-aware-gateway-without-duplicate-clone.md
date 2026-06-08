---
id: PIPE-51.8
title: Dogfood repo-aware gateway without duplicate clone
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - dogfood
dependencies:
  - PIPE-51.5
  - PIPE-51.6
  - PIPE-51.7
references:
  - tests/dogfood-live-runners.test.ts
  - docs/mcp-gateway.md
parent_task_id: PIPE-51
priority: high
ordinal: 144000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prove the repo-aware gateway works through real repository usage. Verification must exercise the actual CLI and generated host surfaces, and must explicitly prove MCP gateway setup did not create a second repository checkout.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Real local command path runs reconcile/configure-host/doctor against the current repo and lists required gateway tools.
- [ ] #2 Runner-job or representative in-pod path proves gateway reconciliation receives the prepared workspace path and does not perform an MCP-specific clone.
- [ ] #3 Process/file evidence shows agents see only pipeline-gateway and no direct upstream MCP host entries are generated.
- [ ] #4 If full live ToolHive or Kubernetes cannot be run, the report states exactly which real-usage layer was not fully verified.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Run package commands through mise/bun as applicable: tests, typecheck, check, build, install-commands --check, gateway doctor, and a live/local gateway smoke when credentials/runtime are available. Capture before/after workspace/process evidence for clone avoidance.
<!-- SECTION:PLAN:END -->
