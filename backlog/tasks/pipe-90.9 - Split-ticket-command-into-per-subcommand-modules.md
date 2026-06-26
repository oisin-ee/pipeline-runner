---
id: PIPE-90.9
title: Split ticket-command into per-subcommand modules
status: Done
assignee: []
created_date: '2026-06-26 14:47'
updated_date: '2026-06-26 15:48'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/commands/ticket-command.ts
parent_task_id: PIPE-90
priority: medium
ordinal: 270000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: behavior-preserving (B) refactor of the 725-line src/commands/ticket-command.ts into src/commands/ticket/ with one module per subcommand (graph-check, sequence, next, start, create) + index.ts subcommand registry. No behavior change. Independent of the gate work (different file) so it runs in parallel.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each ticket subcommand lives in its own commands/ticket/<name>.ts behind an index registry -- Evidence: tree listing; CLI ticket subcommands behave identically
- [ ] #2 ticket-command.ts monolith removed/reduced to the registry -- Evidence: existing ticket CLI tests pass unchanged
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + ticket CLI tests ran fresh; output recorded
<!-- DOD:END -->
