---
id: PIPE-95.8
title: Clear run-control and durable-store strict lint for PIPE-95
status: To Do
assignee: []
created_date: "2026-07-05 19:19"
updated_date: "2026-07-05 18:34"
labels:
  - migration
dependencies:
  - PIPE-95.5
references:
  - >-
    backlog/tasks/pipe-95.5 -
    Stabilize-post-autofix-strict-lint-baseline-for-PIPE-95.md
  - /tmp/pipe95-controller-oxlint-after-format.json
  - oxlint.config.ts
modified_files:
  - src/run-control
  - src/run-state
  - tests/run-control-commands.test.ts
  - tests/run-control-contracts.test.ts
  - tests/run-control-file-store-helpers.ts
  - tests/run-control-heartbeats.test.ts
  - tests/run-control-runtime-event-projection.test.ts
  - tests/run-control-runtime-reporter.test.ts
  - tests/run-control-store.test.ts
  - tests/run-control-store-contract.test.ts
  - tests/run-control-store-cutover.test.ts
  - tests/run-control-store-seam.test.ts
  - tests/run-control-test-helpers.ts
  - tests/run-control-writers-pg.test.ts
  - tests/run-state-git-refs.test.ts
  - tests/durable-resume-postgres.test.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 353000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Clear strict/type-aware/Effect lint diagnostics owned by run-control, durable store, run-state, and paired tests.
Scope: src/run-control/**, src/run-state/**, runtime durable-store files only when they are the store implementation for run-control, and paired tests. Do not touch runner, CLI/config, planning/schedule, tickets, or package metadata unless recording a transferred residual.
Dependencies / Blocked by: PIPE-95.5.
Likely modified files: run-control, run-state, durable-store implementation/tests, and paired tests named by the fresh lint JSON.
Research required: inspect run-control store interfaces, existing file/effect service wrappers, durable-store schema/error patterns, and @effect/platform services before edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- persistence/control lane has data-loss and behaviour risk; current host exposes gpt-5.5.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
  Escalation:
- Met: run-control diagnostics clear with focused tests and typecheck.
- Unmet: record exact run-control file/rule/count and missing store/service contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Run-control diagnostics are cleared. -- Evidence: parsed oxlint JSON filtered to run-control/run-state/durable-store paths shows zero errors except transferred residuals with rule/file/count.
- [ ] #2 Run-control behaviours remain covered. -- Evidence: focused run-control and durable-store tests pass and nub run typecheck exits 0.
- [ ] #3 Write boundary is respected. -- Evidence: review lists any non-run-control file touched and why it was required, otherwise no out-of-bound source/test edits.
- [ ] #4 No shortcut suppressions or type escapes are introduced. -- Evidence: git diff --check exits 0 and added-line escape scan exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Filter lint JSON to run-control, run-state, and durable-store paths, group by persistence or service boundary, repair one seam at a time, run focused tests, then rerun filtered counts and typecheck.

<!-- SECTION:PLAN:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
