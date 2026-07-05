---
id: PIPE-52.5
title: Gate completion on verifier and acceptance evidence
status: Done
assignee: []
created_date: "2026-06-08 19:01"
updated_date: "2026-06-08 20:05"
labels:
  - verification
  - gates
dependencies:
  - PIPE-52.3
references:
  - src/gates.ts
  - src/runner-output.ts
  - src/standard-output-schemas.ts
modified_files:
  - src/gates.ts
  - src/runner-output.ts
  - src/runtime/goal-state/goal-state.ts
parent_task_id: PIPE-52
priority: high
ordinal: 150000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make goal-loop completion depend on deterministic verifier and acceptance outputs, and convert failed verification into structured continuation input.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Verifier and acceptance gate results update goal state with criterion-level evidence and violation details.
- [ ] #2 A node or workflow cannot mark the goal passed solely from runner prose or implementation self-reporting.
- [ ] #3 Failed verifier or acceptance output can produce a continuation input object consumed by PIPE-52.4.
- [ ] #4 Tests cover pass, fail, malformed verifier output, repair attempt, and repeated failure signatures.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Extend existing gates/output-normalization path rather than creating a separate verifier parser. Preserve current json_schema repair behavior. Add tests around src/gates.ts, src/runner-output.ts, and runtime goal-state updates.

<!-- SECTION:PLAN:END -->
