---
id: PIPE-15
title: Document and polish the pipeline CLI
status: To Do
assignee: []
created_date: '2026-05-21 09:20'
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
