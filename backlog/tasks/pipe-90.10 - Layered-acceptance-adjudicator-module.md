---
id: PIPE-90.10
title: Layered acceptance adjudicator module
status: To Do
assignee: []
created_date: '2026-06-26 14:48'
labels: []
dependencies:
  - PIPE-90.7
  - PIPE-90.8
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/gates/adjudicator/adjudicator.ts
  - src/runtime/gates/registry.ts
parent_task_id: PIPE-90
priority: high
ordinal: 271000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: deep module gates/adjudicator/ (adjudicator.ts + .test.ts + index.ts). Small interface adjudicate(criteria, claim, attempt) -> GateVerdict{passed, unmet[]}, hiding the layered pipeline: deterministic kinds (via registry) -> structured-claim -> llm-judge residue (anchored to deterministic evidence, never standalone). Wires/registers the structured-claim + llm-judge descriptors. Aggregates all failures into one structured refusal.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Adjudicator runs layers in order deterministic -> structured-claim -> llm-judge -- Evidence: unit tests for deterministic-fail, claim-incomplete, judge-residue, all-pass
- [ ] #2 Verdict aggregates every unmet criterion across layers (not first-fail-only) -- Evidence: multi-unmet test asserts full unmet[]
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + adjudicator unit tests ran fresh; output recorded
<!-- DOD:END -->
