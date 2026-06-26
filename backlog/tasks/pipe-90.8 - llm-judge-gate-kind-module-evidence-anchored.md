---
id: PIPE-90.8
title: llm-judge gate kind module (evidence-anchored)
status: Done
assignee: []
created_date: '2026-06-26 14:47'
updated_date: '2026-06-26 16:56'
labels: []
dependencies:
  - PIPE-90.2
  - PIPE-90.1
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/gates/kinds/llm-judge/llm-judge.ts
parent_task_id: PIPE-90
priority: medium
ordinal: 269000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: new gate kind in its own module gates/kinds/llm-judge/ (name.ts + name.test.ts + index.ts). Adjudicates ONLY un-encodable residue criteria; verdict MUST cite the deterministic evidence relied on (never standalone-authoritative); refuses trivial/empty input (anti-gaming). Exports a GateEvaluator descriptor; does NOT edit the shared registry barrel (wired in adjudicator) to stay parallel with structured-claim.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Verdict references deterministic evidence; no-anchor verdict rejected -- Evidence: unit test feeding trivial/empty input is refused
- [ ] #2 Module self-contained, exports GateEvaluator descriptor; no edits to gates.ts/registry.ts -- Evidence: diff touches only gates/kinds/llm-judge/*
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + module unit tests ran fresh; output recorded
<!-- DOD:END -->
