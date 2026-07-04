---
id: PIPE-48
title: Create a canonical workflow graph traversal model
status: Done
assignee: []
created_date: '2026-06-04 14:41'
updated_date: '2026-07-04 19:43'
labels:
  - tech-debt
  - maintainability
  - workflow-planner
  - config
  - schedule
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/workflow-planner.ts
  - src/schedule-planner.ts
  - src/config.ts
  - tests/workflow-planner.test.ts
  - tests/schedule-planner.test.ts
  - tests/config.test.ts
priority: medium
ordinal: 115000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow node traversal and graph reasoning are implemented separately in schedule planning, config validation, and workflow planning. This makes each new workflow primitive or nested-node behavior more expensive and increases the risk that validation, planning, and scheduling disagree. Introduce a canonical workflow graph/traversal model that the relevant layers can share without leaking unrelated responsibilities.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A shared workflow graph/traversal API covers nested node flattening, dependency lookup, downstream traversal, and cycle/dependency reasoning needed by config validation, workflow planning, and schedule validation.
- [ ] #2 Existing config validation, workflow planning, and schedule validation behavior is preserved or intentionally tightened with tests.
- [x] #3 Duplicate ad hoc traversal helpers are removed or reduced in the affected modules.
- [x] #4 The shared model does not become a broad dumping ground; each caller still owns its layer-specific policy decisions.
- [ ] #5 Tests cover nested parallel/workflow cases through the shared traversal behavior and representative public planner/config APIs.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped — commit 7699cab "refactor: canonical workflow graph traversal model (PIPE-48)", plus 02c81ee "refactor(planning): centralize dag graph semantics". Canonical model lives in `src/planning/graph.ts` (490 lines): `flattenNodes` (nested node flattening), `createDependencyGraph`, `dependencyPredecessorIds`/`successorIds` (dependency lookup), `descendantGraphValues`/`hasReachableDependent` (downstream traversal), `dependencyCycleIds`/`findDependencyCycles`/`topologicalDependencyOrder`/`dependencyBatches` (cycle + ordering reasoning), `dependentsByNeed`, `findNode`. It is shared broadly — imported by 14 modules including `planning/compile.ts` (workflow planning), `schedule/passes/*` (coverage, drain-merge, ids, open-pull-request — schedule validation), `argo-graph.ts`, `tickets/ticket-graph.ts`, `run-control/run-record.ts`, and `runtime/events/events.ts`. Ad-hoc traversal helpers in those layers were replaced by the shared API; each caller retains its layer-specific policy (no dumping-ground). Referenced stale paths in the ticket (`src/schedule-planner.ts`, `src/workflow-planner.ts`) were removed by the sibling PIPE-74 restructure.
<!-- SECTION:FINAL_SUMMARY:END -->
