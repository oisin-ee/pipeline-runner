---
id: PIPE-47
title: Split the monolithic runtime test suite by subsystem
status: To Do
assignee: []
created_date: '2026-06-04 14:41'
updated_date: '2026-07-04 19:44'
labels:
  - tech-debt
  - maintainability
  - tests
  - runtime
  - thermo-review
milestone: m-1
dependencies: []
references:
  - report/architecture-review-2026-06-12.md
  - tests/pipeline-runtime.test.ts
priority: medium
ordinal: 114000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`tests/pipeline-runtime.test.ts` is ~3,570 lines (originally ~4,000+; it shrank as subsystem tests were colocated under src/runtime/, but it is still one monolithic file with only 2 top-level describe blocks). It covers scheduling, agent execution, retries, gates, hooks, worktrees, drain merge, cancellation, observability, and nested workflows in one fixture-heavy suite. Split it into subsystem-focused tests so runtime refactors can be reviewed and verified without one monolithic test file owning every behavior. NOTE (2026-07-04): the runtime moved off xstate to Effect (PIPE-83); the previously-referenced tests/runtime-machines-*.test.ts files were deleted in that migration and no longer exist. 39 colocated *.test.ts files already exist under src/runtime/ — reconcile the split against those to avoid duplication. See Implementation Notes for verified current state.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runtime tests are split into subsystem-focused files with clear fixture ownership and minimal cross-suite coupling.
- [ ] #2 Existing behavior coverage for scheduling, node attempts, gates, hooks, workflow nodes, parallel nodes, drain merge, cancellation, and observability is preserved.
- [ ] #3 Shared test helpers are extracted only when they remove meaningful duplication and keep individual tests readable.
- [ ] #4 No runtime test file remains over 1,000 lines unless a specific structural justification is recorded.
- [ ] #5 The full test suite and the real CLI/dogfood paths relevant to runtime execution continue to pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
GROOM 2026-07-04 (verified against repo state):

STILL VALID — the monolith persists. tests/pipeline-runtime.test.ts is 3,570 lines (ticket said 'over 4,000'; corrected — it shrank but is still one file with only 2 top-level describe blocks). It remains the single largest test file and blows past AC #4's 1,000-line cap.

STALE REFERENCES REMOVED: the ticket referenced tests/runtime-machines-{workflow,node,gate,hook}.test.ts. Those existed under the xstate-machines runtime (created in 5d8cefc 'feat: PIPE-67') but were DELETED when the runtime moved off xstate to Effect (PIPE-83). They no longer exist and are not the split target. References field trimmed to the one file that actually needs splitting.

ALREADY PARTIALLY DONE: 39 colocated *.test.ts files now live under src/runtime/ — subsystem coverage already exists for agent-node, gates, goal-loop, goal-state, parallel-node, parallel-worktrees, open-pull-request, changed-files, context, hooks, node-protocol, json-validation, opencode-session-executor, opencode-server, opencode-runtime, node-state-store, handoff, detached-race, contracts, etc. So the 'one monolithic file owns every behavior' premise is now only partly true.

REMAINING WORK: split the 3,570-line tests/pipeline-runtime.test.ts into subsystem-focused files (scheduling, node attempts, retries, gates, hooks, worktrees, drain-merge, cancellation, observability, nested workflows), reconciling with the already-colocated src/runtime tests to avoid duplication — extract shared fixtures only where they remove real duplication. AC #4's 1,000-line ceiling still applies. Verify the full suite + runtime dogfood paths after.
<!-- SECTION:NOTES:END -->
