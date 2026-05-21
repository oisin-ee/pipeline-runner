---
id: PIPE-15
title: Document and polish the pipeline CLI
status: In Progress
assignee:
  - Codex
created_date: '2026-05-21 09:20'
updated_date: '2026-05-21 10:02'
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
priority: medium
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the default Mastra README with practical operating documentation for this repository and make the CLI entrypoint clear for local use. A future user should be able to install dependencies, choose a harness, run the pipeline, and understand generated artifacts without reading the source first.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README explains the pipeline purpose, lifecycle, supported harnesses, and generated artifacts.
- [ ] #2 README documents required tools, environment variables, and exact verification commands.
- [ ] #3 A documented command or package script runs `work-next` with a task description.
- [ ] #4 CLI input validation reports unsupported harness values clearly before starting a run.
- [ ] #5 Documentation explains known limitations and how Backlog.md tickets map to the pipeline phases.
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
