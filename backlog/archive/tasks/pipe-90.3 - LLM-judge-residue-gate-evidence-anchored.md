---
id: PIPE-90.3
title: LLM-judge residue gate (evidence-anchored)
status: To Do
assignee: []
created_date: '2026-06-26 14:26'
labels: []
dependencies:
  - PIPE-90.2
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/gates/gates.ts
parent_task_id: PIPE-90
priority: medium
ordinal: 264000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: a new gate kind adjudicating ONLY the un-encodable residue criteria (those no deterministic/structured-claim gate covers). Verdict MUST be anchored to deterministic evidence (cite the artifacts/test output relied on) and is never standalone-authoritative. Emits structured refusal on fail. Depends on PIPE-90.2 (serialized to avoid gates.ts dispatch-table collision).
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New gate kind invoked only for residue criteria; deterministic-covered criteria never reach it -- Evidence: test asserting routing (deterministic criterion does not call the judge)
- [ ] #2 Judge verdict references the deterministic evidence used; a verdict with no anchor is rejected -- Evidence: test feeding trivial/empty input is refused (anti-gaming)
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + judge-gate unit tests ran fresh; output recorded
<!-- DOD:END -->
