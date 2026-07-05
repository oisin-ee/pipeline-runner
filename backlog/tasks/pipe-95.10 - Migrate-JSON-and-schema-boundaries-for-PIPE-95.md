---
id: PIPE-95.10
title: Clear planning schedule tickets strict lint for PIPE-95
status: To Do
assignee: []
created_date: '2026-07-05 19:19'
updated_date: '2026-07-05 18:34'
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
  - src/planning
  - src/schedule
  - src/tickets
  - src/backlog.ts
  - tests/dependency-refs.test.ts
  - tests/planning-graph.test.ts
  - tests/schedule-drain-merge-pass.test.ts
  - tests/schedule-planner.test.ts
  - tests/schedule-planner-boundaries.test.ts
  - tests/schedule-prompts.test.ts
  - tests/ticket-backlog-store.test.ts
  - tests/ticket-command.test.ts
  - tests/ticket-complete-command.test.ts
  - tests/ticket-graph.test.ts
  - tests/ticket-plan.test.ts
  - tests/ticket-plan-apply.test.ts
  - tests/ticket-selection.test.ts
  - tests/tickets.test.ts
  - tests/workflow-planner.test.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 355000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Clear strict/type-aware/Effect lint diagnostics owned by planning compilation/generation, schedule passes/prompts, Backlog ticket orchestration, ticket completion/selection, and paired tests.
Scope: src/planning/**, src/schedule/**, src/tickets/**, src/backlog.ts, and paired planning/schedule/ticket tests. Do not touch runtime core, runner, run-control, CLI/config, remote/Argo, or package metadata unless recording a transferred residual.
Dependencies / Blocked by: PIPE-95.5.
Likely modified files: planning, schedule, ticket files and paired tests named by the fresh lint JSON.
Research required: inspect schedule graph types, generated schedule schemas, Backlog task store contracts, safe JSON/schema helpers, and existing Effect collection usage before edits.
Model recommendation:
- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- scheduling/ticket lane has graph correctness risk; current host exposes gpt-5.5.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
Escalation:
- Met: planning/schedule/tickets diagnostics clear with focused tests and typecheck.
- Unmet: record exact file/rule/count and missing graph/schema contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Planning/schedule/tickets diagnostics are cleared. -- Evidence: parsed oxlint JSON filtered to this lane write boundary shows zero errors except transferred residuals with rule/file/count.
- [ ] #2 Scheduling and ticket behaviours remain covered. -- Evidence: focused planning/schedule/ticket tests pass and nub run typecheck exits 0.
- [ ] #3 Write boundary is respected. -- Evidence: review lists any out-of-bound file touched and why it was required, otherwise no out-of-bound source/test edits.
- [ ] #4 No shortcut suppressions or type escapes are introduced. -- Evidence: git diff --check exits 0 and added-line escape scan exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Filter lint JSON to planning/schedule/tickets paths, group by graph/schema/ticket contract, repair one seam at a time, run focused tests, then rerun filtered counts and typecheck.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
