---
id: PIPE-45.6
title: Finish ticket command split
status: Done
assignee: []
created_date: '2026-06-27 14:03'
updated_date: '2026-06-27 15:50'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/commands/ticket-command.ts
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
  - tests/ticket-plan.test.ts
  - tests/ticket-selection.test.ts
  - >-
    backlog/tasks/pipe-90.9 -
    Split-ticket-command-into-per-subcommand-modules.md
parent_task_id: PIPE-45
priority: medium
ordinal: 301000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Finish splitting ticket command registration, parsing, plan/apply/completion handling, and Backlog store access. Correct stale Done cleanup claims that no longer match source.
Dependencies: PIPE-45.1
Likely modified files: src/commands/ticket-command.ts, src/commands/ticket/*, tests/ticket-command.test.ts, tests/ticket-*.test.ts
Reuse: existing Backlog task store and command helpers; no alternate tracker/client.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Ticket command file owns registration only; behaviours move to focused modules -- Evidence: source inspection and line-count output.
- [x] #2 Ticket plan/apply/complete/select flows keep behaviour -- Evidence: focused ticket tests pass.
- [x] #3 Stale cleanup task claims are corrected in Backlog notes where needed -- Evidence: task notes/diff.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Confirmed ticket-command.ts is already the 36-line registration owner and all behaviours live in focused src/commands/ticket/* modules. Corrected stale PIPE-90.9 Done metadata to match source and avoid adding an index/facade file. Proof: wc -l over ticket command modules, source grep, and focused ticket tests (7 files, 42 tests) passed.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
