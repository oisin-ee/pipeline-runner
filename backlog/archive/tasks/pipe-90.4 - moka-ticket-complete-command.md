---
id: PIPE-90.4
title: moka ticket complete command
status: To Do
assignee: []
created_date: '2026-06-26 14:26'
updated_date: '2026-06-26 14:46'
labels: []
dependencies:
  - PIPE-90.1
  - PIPE-90.2
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/commands/ticket-command.ts
  - src/tickets/backlog-task-store.ts
parent_task_id: PIPE-90
priority: high
ordinal: 265000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: a 'moka ticket complete <id>' subcommand. Accepts a structured evidence claim (typed args), loads the ticket's acceptance criteria from the backlog store, runs the layered adjudicator, then: on pass -> set status Done; on fail -> print the structured refusal (unmet[]) and exit nonzero WITHOUT marking Done. Replaces the current manual backlog task edit --status Done completion path (ticket-command.ts:302-304).
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 moka ticket complete refuses with structured unmet[] and nonzero exit when criteria unmet; ticket stays not-Done -- Evidence: CLI integration test asserting refusal output + status unchanged
- [ ] #2 moka ticket complete sets status Done only when adjudicator passes -- Evidence: CLI integration test asserting Done on full-evidence claim
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + ticket-command integration tests ran fresh; output recorded
<!-- DOD:END -->
