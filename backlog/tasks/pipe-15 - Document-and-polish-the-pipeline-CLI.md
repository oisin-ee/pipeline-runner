---
id: PIPE-15
title: Document and polish the pipeline CLI
status: Done
assignee:
  - Codex
created_date: "2026-05-21 09:20"
updated_date: "2026-05-21 10:07"
labels:
  - docs
  - cli
dependencies:
  - PIPE-10
references:
  - README.md
  - package.json
  - src/index.ts
  - backlog/tasks/
modified_files:
  - README.md
  - package.json
  - src/index.ts
  - tests/cli.test.ts
priority: medium
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Replace the default Mastra README with practical operating documentation for this repository and make the CLI entrypoint clear for local use. A future user should be able to install dependencies, choose a harness, run the pipeline, and understand generated artifacts without reading the source first.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 README explains the pipeline purpose, lifecycle, supported harnesses, and generated artifacts.
- [x] #2 README documents required tools, environment variables, and exact verification commands.
- [x] #3 A documented command or package script runs `work-next` with a task description.
- [x] #4 CLI input validation reports unsupported harness values clearly before starting a run.
- [x] #5 Documentation explains known limitations and how Backlog.md tickets map to the pipeline phases.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Implementation plan:

1. Work in dedicated `wt` branch/worktree `pipe-15-cli-docs` based on current `main`.
2. Update README with final pipeline purpose, lifecycle, supported harnesses, environment variables, artifacts, verification commands, and Backlog phase mapping.
3. Add or document a package script for `work-next` and improve CLI harness validation so unsupported `PIPELINE_HARNESS` values fail before starting a run.
4. Add focused tests for CLI validation/script behavior where appropriate.
5. Run `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`; commit scoped branch changes before handoff.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Expanded README with final pipeline purpose, lifecycle, supported harnesses, environment variables, generated artifacts, Backlog phase mapping, known limitations, and exact verification commands. Added `bun run work-next` package script. Added CLI validation for unsupported `PIPELINE_HARNESS` before Backlog tasks or workflow runs start, with focused tests. Verification passed on main: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`. Merged implementation commit: 48b4965.

<!-- SECTION:FINAL_SUMMARY:END -->
