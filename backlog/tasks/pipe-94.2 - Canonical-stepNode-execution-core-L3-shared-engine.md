---
id: PIPE-94.2
title: Canonical stepNode execution core (L3 shared engine)
status: Done
assignee: []
created_date: "2026-06-28 19:52"
updated_date: "2026-06-28 20:21"
labels: []
dependencies: []
modified_files:
  - src/runtime/step/step-node.ts
  - src/run-control/next-node.ts
  - src/run-control/submit-result.ts
parent_task_id: PIPE-94
priority: high
ordinal: 323000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: extract the atomic shared step unit stepNode(deps) = build NextNodeEnvelope for a given nodeId (buildNextNodeEnvelope) -> execute node (runScheduledWorkflowTask) -> record RuntimeNodeResult (DurableRunStore.record, same path as recordSubmitResult). Selection (computeReadyNodeIds) stays the caller concern. Add a thin stepRun loop (pick-next-ready + stepNode) for loop callers. next node / submit-result CLI refactored to delegate to the shared funcs so they are no longer an island.
Dependencies: none (uses existing funcs)
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 stepNode builds envelope, executes, and records the RuntimeNodeResult to the durable store for a given nodeId -- Evidence: unit test: stepNode then store.get returns the recorded result; next node advances
- [ ] #2 next node + submit-result CLI delegate to the shared core; existing CLI tests still green -- Evidence: tests/next-node\*, submit-result.test.ts pass
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
