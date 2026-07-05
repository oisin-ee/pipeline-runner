---
id: PIPE-90.9
title: Split ticket-command into per-subcommand modules
status: Done
assignee: []
created_date: "2026-06-26 14:47"
updated_date: "2026-06-27 15:50"
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/commands/ticket-command.ts
  - src/commands/ticket/graph-check.ts
  - src/commands/ticket/sequence.ts
  - src/commands/ticket/next.ts
  - src/commands/ticket/start.ts
  - src/commands/ticket/create.ts
  - src/commands/ticket/complete.ts
  - src/commands/ticket/shared.ts
  - tests/ticket-command.test.ts
  - tests/ticket-complete-command.test.ts
parent_task_id: PIPE-90
priority: medium
ordinal: 270000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: behavior-preserving refactor of the former 725-line src/commands/ticket-command.ts into src/commands/ticket/ with one module per subcommand (graph-check, sequence, next, start, create, complete) plus the existing ticket-command.ts registration table. No behavior change. No index/facade file is needed because ticket-command.ts owns registration.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Each ticket subcommand lives in its own commands/ticket/<name>.ts behind the ticket-command registry -- Evidence: tree listing and focused CLI tests.
- [x] #2 ticket-command.ts monolith is reduced to registration-only dispatch -- Evidence: wc -l shows 36 lines and focused ticket CLI tests pass.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Corrected stale Done metadata to match the current source: ticket-command.ts is the 36-line registration owner, and command behaviour lives in focused src/commands/ticket/\* modules. No index/facade file was added because it would not own behaviour. Proof: wc -l over ticket command modules and focused ticket tests passed.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the feature-implementation workflow in order
- [x] #2 pnpm run check + ticket CLI tests ran fresh; output recorded
<!-- DOD:END -->
