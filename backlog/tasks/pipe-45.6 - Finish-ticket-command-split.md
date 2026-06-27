---
id: PIPE-45.6
title: Finish ticket command split
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/commands/ticket-command.ts
modified_files:
  - src/commands/ticket-command.ts
  - tests/ticket-command.test.ts
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
- [ ] #1 Ticket command file owns registration only; behaviours move to focused modules -- Evidence: source inspection and line-count output.
- [ ] #2 Ticket plan/apply/complete/select flows keep behaviour -- Evidence: focused ticket tests pass.
- [ ] #3 Stale cleanup task claims are corrected in Backlog notes where needed -- Evidence: task notes/diff.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
