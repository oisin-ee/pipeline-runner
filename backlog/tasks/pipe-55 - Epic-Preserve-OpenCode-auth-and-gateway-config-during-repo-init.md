---
id: PIPE-55
title: 'Epic: Preserve OpenCode auth and gateway config during repo init'
status: To Do
assignee: []
created_date: '2026-06-10 14:58'
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
Fix the repo-local OpenCode config path so pipe init preserves existing auth plugin and pipeline-gateway MCP configuration while still projecting package-owned defaults. Root cause: pipe init forces generated .opencode/opencode.json as a whole file, which can overwrite repo-local plugin and MCP entries and leave stale package defaults such as missing oc-codex-multi-auth.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Backlog child tickets cover reproduction, merge contract, installer wiring, real OpenCode verification, and docs.
- [ ] #2 The dependency graph allows PIPE-55.1 and PIPE-55.2 to start in parallel, PIPE-55.3 after the merge contract, and verification/docs after installer wiring.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Drain child tickets in dependency order. Do not dispatch implementation until backlog sequence shows no same-batch modified-file conflicts.
<!-- SECTION:PLAN:END -->
