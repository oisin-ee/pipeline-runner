---
id: PIPE-45.3
title: Consolidate workflow graph semantics
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/planning/compile.ts
  - src/argo-graph.ts
modified_files:
  - src/planning/graph.ts
  - src/planning/compile.ts
  - src/argo-graph.ts
  - src/tickets/ticket-graph.ts
  - tests/planning-graph.test.ts
  - tests/ticket-graph.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 298000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Put workflow graph traversal/compilation semantics behind one planning graph owner. Keep repo-map graphology separate from workflow DAG graphlib.
Dependencies: PIPE-45.1
Likely modified files: src/planning/graph.ts, src/planning/compile.ts, src/argo-graph.ts, src/tickets/ticket-graph.ts, tests/planning-graph.test.ts, tests/ticket-graph.test.ts
Reuse: @dagrejs/graphlib for workflow DAGs; graphology remains repo-map/ranking only.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Workflow DAG graph operations are owned by one module family -- Evidence: import/source inspection.
- [ ] #2 Planning, Argo, and ticket graph tests preserve current semantics -- Evidence: focused tests pass.
- [ ] #3 No new graph implementation or architecture tooling is introduced -- Evidence: package.json diff/source inspection.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
