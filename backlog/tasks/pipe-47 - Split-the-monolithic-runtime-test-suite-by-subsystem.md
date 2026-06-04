---
id: PIPE-47
title: Split the monolithic runtime test suite by subsystem
status: To Do
assignee: []
created_date: '2026-06-04 14:41'
labels:
  - tech-debt
  - maintainability
  - tests
  - runtime
  - thermo-review
milestone: m-1
dependencies: []
references:
  - tests/pipeline-runtime.test.ts
  - tests/runtime-machines-workflow.test.ts
  - tests/runtime-machines-node.test.ts
  - tests/runtime-machines-gate.test.ts
  - tests/runtime-machines-hook.test.ts
priority: medium
ordinal: 114000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`tests/pipeline-runtime.test.ts` is over 4,000 lines and mirrors the runtime god module. It covers scheduling, agent execution, retries, gates, hooks, worktrees, drain merge, cancellation, observability, and nested workflows in one fixture-heavy suite. Split it into subsystem-focused tests so runtime refactors can be reviewed and verified without one monolithic test file owning every behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runtime tests are split into subsystem-focused files with clear fixture ownership and minimal cross-suite coupling.
- [ ] #2 Existing behavior coverage for scheduling, node attempts, gates, hooks, workflow nodes, parallel nodes, drain merge, cancellation, and observability is preserved.
- [ ] #3 Shared test helpers are extracted only when they remove meaningful duplication and keep individual tests readable.
- [ ] #4 No runtime test file remains over 1,000 lines unless a specific structural justification is recorded.
- [ ] #5 The full test suite and the real CLI/dogfood paths relevant to runtime execution continue to pass.
<!-- AC:END -->
