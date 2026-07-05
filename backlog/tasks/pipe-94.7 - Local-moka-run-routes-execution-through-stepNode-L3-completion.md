---
id: PIPE-94.7
title: Local moka run routes execution through stepNode (L3 completion)
status: Done
assignee: []
created_date: "2026-06-28 19:52"
updated_date: "2026-06-28 21:57"
labels: []
dependencies:
  - PIPE-94.2
modified_files:
  - src/runtime/scheduler.ts
parent_task_id: PIPE-94
priority: medium
ordinal: 328000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: LocalScheduler runNode goes through the shared stepNode core (build env + execute + record) instead of the bespoke recordToJournal call; computeReadyNodeIds already shared. Result: local run + runner-command + CLI all share exactly one execution core. Behaviour must stay byte-identical (regression via PIPE-57 goldens).
Dependencies: PIPE-94.2
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Local moka run uses the single stepNode core; PIPE-57 goldens unchanged -- Evidence: golden regression run output recorded
- [ ] #2 Journal recording behaviour preserved (resume of a local run still skips passed nodes) -- Evidence: existing resume tests green
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
