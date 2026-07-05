---
id: PIPE-90.2
title: Gate registry seam (switch to data-driven dispatch)
status: Done
assignee: []
created_date: "2026-06-26 14:26"
updated_date: "2026-06-26 16:17"
labels: []
dependencies:
  - PIPE-90.1
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/gates/registry.ts
  - src/runtime/gates/orchestrator.ts
  - src/runtime/gates/gates.ts
  - src/runtime/gates/index.ts
parent_task_id: PIPE-90
priority: high
ordinal: 263000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: convert the gate kind dispatch from switch(gate.kind) (gates.ts:351) to a data-driven registry Record<GateKind, GateEvaluator>, and extract the eval loop + observability into gates/orchestrator.ts. Public surface gates/index.ts exposes evaluateNodeGates() + a way to register kinds. Behavior-preserving seam that turns new gate kinds into drop-in modules instead of new switch arms. THE anti-imperative SHAPE fix.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 All 7 existing kinds evaluate identically through the registry -- Evidence: existing gates.test.ts passes unchanged
- [ ] #2 Gate kind dispatch is a registry table, not a switch; assertNever switch removed -- Evidence: no switch(gate.kind) in tree; registry unit test resolves each kind
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + adjudicator unit tests ran fresh; output recorded
<!-- DOD:END -->
