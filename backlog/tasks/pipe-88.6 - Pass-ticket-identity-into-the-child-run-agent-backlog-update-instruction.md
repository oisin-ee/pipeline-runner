---
id: PIPE-88.6
title: Pass ticket identity into the child run + agent backlog-update instruction
status: Done
assignee: []
created_date: "2026-06-21 19:27"
updated_date: "2026-07-04 19:43"
labels: []
dependencies: []
modified_files:
  - src/commands/ticket-command.ts
  - src/runner-command/task-descriptor.ts
parent_task_id: PIPE-88
priority: medium
ordinal: 250000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: src/commands/ticket-command.ts (ticketRunTask), src/runner-command/task-descriptor.ts. Today only title+description string is passed. Pass ticket id + instruct the agent to update ticket status/ACs via backlog tools on its branch (merges to main). Loop stays authoritative via in-memory node-state; this is the decoupled, agent-owned backlog edit.
Dependencies: none
Escalation: report Met/Unmet with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Child run task descriptor carries the ticket id -- Evidence: test asserts id present in descriptor
- [x] #2 Agent prompt instructs backlog status/AC update via tools, not loop-side .md writes -- Evidence: descriptor/template test asserts instruction text
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

DONE. Ticket identity threaded into the child run + agent backlog-update instruction.

Evidence:

- Ticket id carried through the run: src/cli/run-command.ts:14 RunCommandCall.ticketId; runner-command-contract.ts:363 readonly ticketId: string; runner-event-schema.ts:207 ticketId. Threaded in commit 92cdaac "feat(ticket): thread ticketId into RunCommandCall and add backlog status directive".
- Agent prompt instructs backlog status/AC update via tools (not loop-side .md writes): src/commands/ticket/start.ts:44-56 BACKLOG_STATUS_DIRECTIVE — "Your first action must be to set this ticket to In Progress ... final action ... set this ticket to Done and update its acceptance criteria through the backlog tools ... Use backlog tools on your working branch. Do not hand-edit the task markdown file." ticketRunTask appends the directive (with <TICKET_ID> substituted) to the task body and returns { task, ticketId }.
- Tests green: tests/ticket-command.test.ts (18 passed).

Note: ticket-command.ts was later refactored into per-subcommand modules (PIPE-90.9); the ticketId + directive live in src/commands/ticket/start.ts now. AC1/2 met.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on ticket-command/task-descriptor; record output
<!-- DOD:END -->
