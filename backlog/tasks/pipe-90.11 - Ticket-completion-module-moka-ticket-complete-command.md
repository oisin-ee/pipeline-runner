---
id: PIPE-90.11
title: Ticket completion module + moka ticket complete command
status: Done
assignee: []
created_date: "2026-06-26 14:48"
updated_date: "2026-06-26 17:30"
labels: []
dependencies:
  - PIPE-90.10
  - PIPE-90.9
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/tickets/completion/complete-ticket.ts
  - src/commands/ticket/complete.ts
parent_task_id: PIPE-90
priority: high
ordinal: 272000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: deep module src/tickets/completion/ (complete-ticket.ts + .test.ts + index.ts) owning the use-case: load ticket acceptance criteria -> adjudicate -> on pass set status Done, on fail return structured refusal (unmet[]) and DO NOT mark Done. Plus a thin commands/ticket/complete.ts shell (from the PIPE-90.9 registry) over the use-case. Replaces the manual backlog task edit --status Done path (ticket-command.ts:302-304).
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 moka ticket complete refuses with structured unmet[] + nonzero exit; ticket stays not-Done -- Evidence: CLI integration test asserting refusal + status unchanged
- [ ] #2 moka ticket complete sets Done only on adjudicator pass -- Evidence: CLI integration test asserting Done on full-evidence claim
- [ ] #3 CLI command is a thin shell; completion logic lives in tickets/completion module -- Evidence: use-case unit-tested without the CLI
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + completion unit + CLI integration tests ran fresh; output recorded
<!-- DOD:END -->
