---
id: PIPE-51
title: "Epic: repo-aware MCP gateway without duplicate workspaces"
status: To Do
assignee: []
created_date: "2026-06-08 15:54"
updated_date: "2026-07-04 19:45"
labels:
  - epic
  - mcp
  - gateway
dependencies: []
references:
  - src/mcp/gateway.ts
  - src/config.ts
  - docs/mcp-gateway.md
priority: high
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make every repo-aware MCP server available through the singleton pipeline-gateway while preserving the active checkout as the only repository workspace. Agents must still see exactly one MCP server. Gateway-local and runner-job paths must bind repo-aware backends to PIPELINE_TARGET_PATH/current cwd or the already-prepared /workspace volume, never clone or mirror the repository for MCP.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Codex and OpenCode host configs still contain only pipeline-gateway.
- [x] #2 Repo-aware backends bind to the existing checkout/workspace; no gateway code clones, mirrors, or copies the repo.
- [ ] #3 Local dev and runner-job paths can expose the required repo-aware backends through one gateway URL.
- [x] #4 Doctor/verification fails when required gateway backends/tools are missing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Deliver contract/schema first, then fan out backend inventory, repo-local backend definitions, runner-job binding, and doctor verification. Finish with docs and real repository usage verification.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Grooming 2026-07-04 (opus), verified against current repo + green test runs (vitest run: config 64, mcp-toolhive-vmcp 3, mcp-repo-local-backends 3, mcp-gateway-renderers 2, cli 52, dogfood-installed 8, opencode-gateway-scope 3 — all passing).

Status of the 8 subtasks:

- DONE + verified: 51.1 (backend contract, src/config/schema/mcp.ts), 51.2 (toolhive-vmcp render), 51.3 (repo-local backend specs), 51.4 (`moka mcp gateway reconcile` CLI), 51.6 (doctor tools/list), 51.7 (defaults + docs).
- ARCHIVED (superseded): 51.5 — runner-job local-reconcile subsystem was removed (commit 269f097) and the gateway pivoted to INFRA-hosted (mode: hosted); runner pods now connect to the hosted URL with injected PIPELINE_MCP_GATEWAY_AUTHORIZATION rather than reconciling locally.
- OPEN: 51.8 — live dogfood against the hosted gateway (real reconcile/configure-host/doctor + tools/list) is the only remaining work; the file/config-surface layer is already proven by tests.

Epic ACs #1 (singleton pipeline-gateway host config), #2 (repo-aware backends bind to existing checkout, no clone), #4 (doctor fails on missing backends/tools) are met and verified in code + tests — CHECKED. AC#3 (local + runner expose backends via one gateway URL) is met for local dev via reconcile and for runners via the hosted gateway URL, but left UNCHECKED pending 51.8's live end-to-end verification.

Keep epic To Do until 51.8 lands. Note: several ticket file/symbol references are stale after the moka refactor + config split + gateway.ts split (5732c6e) — corrected per-subtask. gateway.ts → src/mcp/gateway-{config,reconcile,doctor,runtime}.ts; config.ts → src/config/_; runner-job/_ removed.

<!-- SECTION:NOTES:END -->
