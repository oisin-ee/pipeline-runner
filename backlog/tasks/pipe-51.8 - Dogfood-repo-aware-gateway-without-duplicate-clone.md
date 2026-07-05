---
id: PIPE-51.8
title: Dogfood repo-aware gateway without duplicate clone
status: To Do
assignee: []
created_date: "2026-06-08 15:54"
updated_date: "2026-07-04 19:45"
labels:
  - mcp
  - gateway
  - dogfood
dependencies:
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
- [x] #3 Process/file evidence shows agents see only pipeline-gateway and no direct upstream MCP host entries are generated.
- [ ] #4 If full live ToolHive or Kubernetes cannot be run, the report states exactly which real-usage layer was not fully verified.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Run package commands through mise/bun as applicable: tests, typecheck, check, build, install-commands --check, gateway doctor, and a live/local gateway smoke when credentials/runtime are available. Capture before/after workspace/process evidence for clone avoidance.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Grooming 2026-07-04 (opus), verified against current repo:

Architecture pivoted since this ticket was written: the gateway is now INFRA-hosted (mode: hosted, https://pipeline-mcp.momokaya.ee/mcp/, chart in infra repo k8s/charts/pipeline-mcp-gateway, INFRA-074), not a per-run local reconcile. Re-scope the dogfood accordingly.

Already satisfied / verified green (2026-07-04 vitest run):

- AC#3 (agents see only pipeline-gateway; no direct upstream host entries): tests/dogfood-installed.test.ts (8) + tests/dogfood-live-runners.test.ts + tests/opencode-project-gateway-scope.test.ts assert generated host surfaces (.opencode/opencode.json etc.) carry only the singleton pipeline-gateway and profiles.mcp_servers is [pipeline-gateway]. CHECKED.
- Clone avoidance is proven at the unit layer: tests/mcp-repo-local-backends.test.ts proves workspacePath is reused from PIPELINE_TARGET_PATH/cwd and no clone/copy command is generated; runner sets PIPELINE_TARGET_PATH to the prepared worktree (src/run-control/detach.ts:41).

Remaining (the live layer this ticket exists to prove):

- AC#1: run the real CLI path against this repo end-to-end — `moka mcp gateway reconcile`, `configure-host`, then `doctor` — against the hosted gateway and confirm `tools/list` returns the required prefixes (context7, uidotsh, qdrant, fallow, serena, backlog). Needs a reachable hosted gateway + PIPELINE_MCP_GATEWAY_AUTHORIZATION.
- AC#2: reframe from 'runner-job in-pod reconcile' (that subsystem was removed — see PIPE-51.5 archive) to 'hosted runner path connects to the hosted gateway URL with injected auth and does not MCP-clone'. Confirm via a representative Argo/remote submit run.
- AC#4: capture the report stating exactly which live layer (hosted ToolHive / K8s) could not be fully exercised.

Update references: drop src/runner-job/_; the runner path now lives under src/remote/argo/_ and src/run-control/\*.

<!-- SECTION:NOTES:END -->
