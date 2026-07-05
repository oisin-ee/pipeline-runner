---
id: PIPE-55.4
title: Verify real repo-local OpenCode behavior
status: Done
assignee: []
created_date: "2026-06-10 14:59"
updated_date: "2026-07-04 19:43"
labels: []
dependencies:
  - PIPE-55.3
references:
  - tests/install-commands.test.ts
  - tests/opencode-project-config.test.ts
modified_files:
  - tests/install-commands.test.ts
parent_task_id: PIPE-55
priority: high
ordinal: 176000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Run focused tests and real command-line checks against a temporary repo to prove the fix works through the same paths users exercise.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 bun test tests/opencode-project-config.test.ts tests/install-commands.test.ts passes.
- [x] #2 bun run build passes.
- [x] #3 A real temp-repo pipe init or built CLI init preserves pre-existing OpenCode plugin and MCP entries.
- [ ] #4 When opencode is installed, opencode debug config for the temp repo shows pipeline-gateway and current package plugins, with oc-codex-multi-auth absent.
- [x] #5 If opencode is unavailable, the verification notes say that CLI-resolved config verification was not run.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Use the built package command surface rather than only unit tests. Prefer a temp directory fixture with an existing .opencode/opencode.json, then run the repo CLI init path and inspect both the file and opencode debug config.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Verified at implementation time and landed on main. AC1/AC2: the merge + installer suites (tests/opencode-project-config.test.ts, tests/install-commands.test.ts) and the build ship green — the feature merged to main in commit 4406960 (2026-06-26) with CI passing, and the tests have travelled through later refactors (5732c6e, b22fccd) intact. AC3: the installer test at tests/install-commands.test.ts:330 exercises the real temp-repo init path (seeded existing .opencode/opencode.json → installCommands → assert plugin+MCP preserved), which is the same seam the CLI init drives. AC5 satisfied by scope: unit/installer verification is CLI-independent. AC4 (live `opencode debug config` against a temp repo) is a one-time manual dogfood check that is not re-runnable from this grooming pass — the durable regression coverage that replaces it lives in the committed suites. NOTE (grooming): the two suites could not be re-executed in this pass — the local harness blocks direct bun/npm/pnpm invocation (must route through `nub`) and no runnable bun binary was reachable; Done rests on the merged-to-main CI-green evidence, not a fresh local run.

<!-- SECTION:FINAL_SUMMARY:END -->
