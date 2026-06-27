---
id: PIPE-45.3
title: Consolidate workflow graph semantics
status: Done
assignee: []
created_date: '2026-06-27 14:03'
updated_date: '2026-06-27 14:49'
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
  - src/schedule/backlog-context.ts
  - src/tickets/ticket-graph.ts
  - src/tickets/ticket-graph-dto.ts
  - src/tickets/ticket-selection.ts
  - tests/planning-graph.test.ts
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
- [x] #1 Workflow DAG graph operations are owned by one module family -- Evidence: import/source inspection.
- [x] #2 Planning, Argo, and ticket graph tests preserve current semantics -- Evidence: focused tests pass.
- [x] #3 No new graph implementation or architecture tooling is introduced -- Evidence: package.json diff/source inspection.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation evidence (2026-06-27):

Research/reuse:
- Local: inspected src/planning/graph.ts, src/planning/compile.ts, src/argo-graph.ts, src/tickets/ticket-graph.ts, src/tickets/ticket-selection.ts, src/tickets/ticket-graph-dto.ts, src/schedule/backlog-context.ts, workflow/ticket/Argo/schedule tests, package.json.
- External/local source: @dagrejs/graphlib README and installed 4.0.1 types expose Graph and graph algorithms for directed DAGs; graphology remains imported only by src/context/repo-map.ts.
- Reuse decision: kept @dagrejs/graphlib for workflow/ticket DAGs, kept graphology for repo-map ranking, no new dependency or architecture tool.
- Optimization check: tested graphlib alg.findCycles on a 10k chain; it throws RangeError: Maximum call stack size exceeded, so the existing iterative cycle detector stays.

Change:
- Added graphlib-backed DAG helper surface to src/planning/graph.ts: graph build, node ids, predecessors, successors, edges, descendant values, cycles, iterative topological order, dependency batches, terminal dependency items.
- Rewired compileWorkflowPlan, Argo graph terminal-task selection, ticket graph sequencing/DTO/selection, and schedule backlog context to use the shared graph owner.
- Preserved PIPE-66 graphlib/iterative toposort decision note in compile.ts while moving traversal mechanics under planning/graph.ts.

Proof commands:
- bunx vitest run tests/planning-graph.test.ts: red first on missing helper exports, then passed 11 tests.
- bunx vitest run tests/planning-graph.test.ts tests/workflow-planner.test.ts tests/ticket-graph.test.ts tests/ticket-selection.test.ts src/tickets/ticket-graph-dto.test.ts tests/argo-workflow.test.ts tests/schedule-planner.test.ts: passed, 7 files, 96 tests.
- bunx vitest run tests/pipe66-decision-notes.test.ts: passed, 4 tests.
- bun run typecheck: passed.
- bun run check: passed, 395 files checked, no fixes applied.
- pnpm exec fallow audit --changed-since HEAD --production: passed. No new issues in 8 changed files; 9 inherited complexity warnings excluded by new-only gate.
- bun run test: passed, 144 files passed, 5 skipped; 1090 tests passed, 41 skipped.
- git diff --check: passed.
- rg source inspection: @dagrejs/graphlib appears only in src/planning/graph.ts production code; graphology appears only in src/context/repo-map.ts production code.

Code Rubric:
- Declarative PASS: DAG semantics are helper operations parameterized by dependency/key callbacks.
- Modular/deep PASS: graphlib graph operations are concentrated in planning graph owner; callers pass data, not traversal logic.
- One owner PASS: workflow/ticket/backlog DAG traversal and edge read helpers live under src/planning/graph.ts.
- Typed/total PASS: helpers use generic DependencyGraph types and boundary value guards; no unsafe casts or suppressions added.
- Reuse PASS: existing @dagrejs/graphlib reused; graphology scope preserved; graphlib recursive cycle finder rejected with measured 10k-chain stack overflow.
- No smells PASS: ultracite, typecheck, fallow audit, and git diff --check pass.
- Verified PASS: focused tests, full suite, static checks, source inspection, and fallow audit ran fresh.

Critique:
- Correctness: workflow topological order/batches, ticket sequencing/selection/DTO, schedule backlog context, and Argo terminal tasks preserve test-covered behaviour.
- Security: no auth, secrets, user-input trust boundary, or external I/O surface changed.
- Performance: compile keeps iterative topological order for 10k chains; graphlib recursive cycle finder was measured and rejected for deep chains.
- Maintainability: direct @dagrejs/graphlib use is out of planner/ticket/Argo/schedule callers and concentrated behind one graph owner.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
