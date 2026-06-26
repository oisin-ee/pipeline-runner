---
id: PIPE-91.7
title: submit-result — feed a RuntimeNodeResult back into the run
status: To Do
assignee: []
created_date: '2026-06-26 17:21'
labels: []
dependencies:
  - PIPE-91.2
  - PIPE-91.4
  - PIPE-91.6
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/run-control/commands.ts
parent_task_id: PIPE-91
priority: high
ordinal: 281000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: the write side of the debug plug — a CLI subcommand (run-control registry, next to moka next node) that accepts a RuntimeNodeResult in the PIPE-91.2 submit shape for (runId,nodeId), validates it, persists it to the durable store (PIPE-91.4), and advances run state so the next 'moka next node' returns the following node. Read-only criteria enforced (decision #7): submit cannot author or mutate criteria.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 submit-result persists a valid result and the next 'moka next node' advances past it -- Evidence: integration test: next node -> submit -> next node returns the dependent node
- [ ] #2 Malformed or criteria-mutating submit is rejected; store unchanged -- Evidence: test asserts a structured rejection and the store is unchanged
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + submit-result tests ran fresh; output recorded
<!-- DOD:END -->
