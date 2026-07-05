---
id: PIPE-95.7
title: Clear runner and runner-command strict lint for PIPE-95
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
  - src/runner.ts
  - src/runner-command
  - src/runner-command-contract.ts
  - src/runner-event-schema.ts
  - src/runner-event-sink.ts
  - src/runner-output.ts
  - src/runner
  - tests/runner-command-fixture.ts
  - tests/runner-command.test.ts
  - tests/runner-command-contract.test.ts
  - tests/runner-command-persistence.test.ts
  - tests/runner-command-policy.test.ts
  - tests/runner-event-sink.test.ts
  - tests/runner-finalize.test.ts
  - tests/runner-image.test.ts
  - tests/runner.test.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 352000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Clear strict/type-aware/Effect lint diagnostics owned by runner execution, runner-command payload/lifecycle, runner event schema/sink/output, and paired runner tests.
Scope: src/runner*.ts, src/runner/**, src/runner-command/**, runner event/schema/output files, and tests/runner*. Do not touch runtime core, run-control, CLI/config, planning/schedule, tickets, or package metadata unless recording a transferred residual.
Dependencies / Blocked by: PIPE-95.5.
Likely modified files: runner and runner-command files plus paired runner tests named by the fresh lint JSON.
Research required: inspect existing runner service seams, event schema helpers, safe JSON helpers, and Effect platform service patterns before edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- runner lane carries execution behaviour risk; current host exposes gpt-5.5.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
  Escalation:
- Met: runner diagnostics clear with focused tests and typecheck.
- Unmet: record exact runner file/rule/count and missing shared contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Runner diagnostics are cleared. -- Evidence: parsed oxlint JSON filtered to runner and runner-command paths shows zero errors except transferred residuals with rule/file/count.
- [ ] #2 Runner behaviours remain covered. -- Evidence: focused runner tests pass and nub run typecheck exits 0.
- [ ] #3 Write boundary is respected. -- Evidence: review lists any non-runner file touched and why it was required, otherwise no out-of-bound source/test edits.
- [ ] #4 No shortcut suppressions or type escapes are introduced. -- Evidence: git diff --check exits 0 and added-line escape scan exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Filter lint JSON to runner paths, group by runner contract/service boundary, repair one boundary at a time, run focused runner tests, then rerun filtered counts and typecheck.

<!-- SECTION:PLAN:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
