---
id: PIPE-55
title: "Epic: Preserve OpenCode auth and gateway config during repo init"
status: Done
assignee: []
created_date: "2026-06-10 14:58"
updated_date: "2026-07-04 19:43"
labels:
  - epic
dependencies: []
references:
  - src/install-commands.ts
  - src/pipeline-init.ts
  - defaults/opencode-ecosystem.yaml
modified_files:
  - src/install-commands.ts
  - src/pipeline-init.ts
priority: high
ordinal: 172000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Fix the repo-local OpenCode config path so pipe init preserves existing plugin and pipeline-gateway MCP configuration while still projecting package-owned defaults. Root cause: pipe init forces generated .opencode/opencode.json as a whole file, which can overwrite repo-local plugin and MCP entries and leave stale package defaults. Broker auth is the current OpenCode auth path; oc-codex-multi-auth must not be reintroduced as a package default.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Backlog child tickets cover reproduction, merge contract, installer wiring, real OpenCode verification, and docs.
- [x] #2 The dependency graph allows PIPE-55.1 and PIPE-55.2 to start in parallel, PIPE-55.3 after the merge contract, and verification/docs after installer wiring.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Drain child tickets in dependency order. Do not dispatch implementation until backlog sequence shows no same-batch modified-file conflicts.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Epic complete — all 5 subtasks verified Done. AC1: child tickets cover reproduction (55.1), merge contract (55.2), installer wiring (55.3), real OpenCode verification (55.4), and docs (55.5). AC2: dependency graph honoured — 55.1/55.2 parallel, 55.3 depends on 55.2, 55.4/55.5 depend on 55.3. Root cause fixed: repo init no longer force-overwrites `.opencode/opencode.json`. The pure `mergeOpenCodeProjectConfig` (src/opencode-project-config.ts, jsonc-parser-based) preserves existing plugin + `mcp.pipeline-gateway` entries and appends only missing package defaults; it is wired through the opencode HostAdapter `mergeDefinition` (src/install-commands/opencode.ts:654-670). oc-codex-multi-auth is not reintroduced as a package default (broker auth remains the OpenCode auth path). `moka mcp gateway configure-host` stays the explicit host-config rewrite-with-backup. Landed commit 4406960 (2026-06-26); still the live init path at HEAD, NOT superseded by the chezmoi harness reframe (750306e, which only changed harness install, not OpenCode project-config merge).

<!-- SECTION:FINAL_SUMMARY:END -->
