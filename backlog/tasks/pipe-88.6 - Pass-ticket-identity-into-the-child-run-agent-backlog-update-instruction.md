---
id: PIPE-88.6
title: Pass ticket identity into the child run + agent backlog-update instruction
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
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
- [ ] #1 Child run task descriptor carries the ticket id -- Evidence: test asserts id present in descriptor
- [ ] #2 Agent prompt instructs backlog status/AC update via tools, not loop-side .md writes -- Evidence: descriptor/template test asserts instruction text
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on ticket-command/task-descriptor; record output
<!-- DOD:END -->
