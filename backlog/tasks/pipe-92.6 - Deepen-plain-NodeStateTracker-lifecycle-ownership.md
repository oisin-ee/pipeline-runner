---
id: PIPE-92.6
title: Deepen plain NodeStateTracker lifecycle ownership
status: Done
assignee: []
created_date: "2026-06-26 22:06"
updated_date: "2026-06-26 23:26"
labels: []
dependencies:
  - PIPE-92.5
references:
  - src/runtime/node-state-tracker.ts
  - tests/runtime-node-state-tracker.test.ts
  - tests/runtime-actor-contract-boundary.test.ts
  - docs/runtime-actor-model.md
  - >-
    backlog/tasks/pipe-59.2 -
    Replace-node-machine-with-plain-NodeStateTracker-and-retry-module.md
modified_files:
  - src/runtime/node-state-tracker.ts
  - tests/runtime-node-state-tracker.test.ts
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-92
priority: medium
ordinal: 295000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: implement the audited plain-runtime node lifecycle contract in NodeStateTracker, preferably as declarative transition data plus a small transition function. Keep pipeline-runtime as event source; the tracker owns state transition legality and output state updates.
Dependencies: PIPE-92.5
Likely modified files: src/runtime/node-state-tracker.ts, tests/runtime-node-state-tracker.test.ts, src/pipeline-runtime.ts, tests/pipeline-runtime.test.ts
Non-goal: do not add xstate or recreate a separate runtime engine.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 NodeStateTracker owns node status transitions through declarative transition data, not scattered status mutation rules -- Evidence: source inspection and focused tracker tests
- [x] #2 Legal sequences for pass, fail, retry, remediation pass, cancel, and skip remain accepted -- Evidence: runtime-node-state-tracker and focused pipeline-runtime tests pass
- [x] #3 Illegal transitions identified by PIPE-92.5 are rejected or surfaced through the agreed error/diagnostic path -- Evidence: negative tracker tests
- [x] #4 xstate remains absent from package metadata, lockfile, runtime, and tests -- Evidence: runtime-actor-contract-boundary test output
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

PIPE-92.5 slice confirmation: keep this as one feature-implementation ticket. The implementation owner is
`NodeStateTracker`; the public seam is `NodeStateTracker.record(event)` plus focused tracker tests. Expected production
shape is declarative transition data and one transition function inside `src/runtime/node-state-tracker.ts`. Do not
split unless implementation needs to change scheduler semantics, public runtime event payloads, or durable store shape.

Use the `docs/runtime-actor-model.md` `Node Execution Event Contract` table as the acceptance contract:

- legal pass, fail, retry, remediation pass, cancel, and skip sequences still work;
- every invalid transition, including every post-terminal event after `passed`, `failed`, `cancelled`, or `skipped`, is
  rejected or surfaced through the agreed deterministic error path before mutation;
- `SUCCESS_HOOKS_STARTED` remains a declared but currently unproduced event unless a separate producer ticket adds it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented after PIPE-92.5. NodeStateTracker now uses declarative nodeExecutionTransitions with allowedFrom/statusAfter/apply data and rejects illegal transitions before mutation. Enforcement exposed and fixed public runtime event-source gaps: remediation synthetic nodes now receive READY and remediation-triggered retries record RETRYING before the next attempt. Proof: bun run test tests/runtime-node-state-tracker.test.ts tests/runtime-actor-contract-boundary.test.ts tests/pipeline-runtime.test.ts passed 76 tests; bun run typecheck passed; bun run check exited 0; bun x ultracite check on touched files passed.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> targeted tests -> implementation -> quality-gate/critique -> verify
- [x] #2 Proof commands recorded: bun run test tests/runtime-node-state-tracker.test.ts tests/runtime-actor-contract-boundary.test.ts tests/pipeline-runtime.test.ts && bun run typecheck && bun run check
<!-- DOD:END -->
