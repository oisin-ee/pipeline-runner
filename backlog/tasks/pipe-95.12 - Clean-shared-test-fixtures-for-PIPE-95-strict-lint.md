---
id: PIPE-95.12
title: Clean shared test fixtures and residual strict lint for PIPE-95
status: To Do
assignee: []
created_date: '2026-07-05 19:19'
updated_date: '2026-07-05 18:34'
labels:
  - migration
dependencies:
  - PIPE-95.6
  - PIPE-95.7
  - PIPE-95.8
  - PIPE-95.9
  - PIPE-95.10
  - PIPE-95.11
references:
  - backlog/tasks/pipe-95.6 - Migrate-absence-and-boolean-models-for-PIPE-95.md
  - >-
    backlog/tasks/pipe-95.7 -
    Move-file-path-temp-IO-to-Effect-services-for-PIPE-95.md
  - >-
    backlog/tasks/pipe-95.8 -
    Move-env-clock-console-process-to-Effect-services-for-PIPE-95.md
  - >-
    backlog/tasks/pipe-95.9 -
    Migrate-tagged-errors-and-Effect-error-flow-for-PIPE-95.md
  - backlog/tasks/pipe-95.10 - Migrate-JSON-and-schema-boundaries-for-PIPE-95.md
  - >-
    backlog/tasks/pipe-95.11 -
    Clear-functional-collection-and-Effect-run-residuals-for-PIPE-95.md
  - /tmp/pipe95-controller-oxlint-after-format.json
modified_files:
  - tests
  - src
parent_task_id: PIPE-95
priority: medium
ordinal: 357000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: After PIPE-95.6 through PIPE-95.11 finish, clear diagnostics that remain because they cross multiple domains, especially shared test fixture builders, shared test helpers, and small paired production seams required by those helpers.
Scope: tests/**/*.ts, src/**/*.test.ts, shared test helpers, and only the smallest paired production seam when a test fixture proves the public API is missing. Excludes domain-owned source migrations unless explicitly transferred with evidence from a completed lane.
Dependencies / Blocked by: PIPE-95.6, PIPE-95.7, PIPE-95.8, PIPE-95.9, PIPE-95.10, PIPE-95.11.
Likely modified files: tests/**/*.ts, src/**/*.test.ts, tests/run-control-test-helpers.ts, tests/gate-test-context.ts, tests/runner-command-fixture.ts, and paired production files only if documented.
Research required: run fresh oxlint JSON after all domain lanes; inspect existing test helper patterns before adding builders; prefer typed helper factories over assertions; run targeted Vitest files named by the gate.
Model recommendation:
- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-medium -- test-fixture cleanup with known patterns; current host exposes gpt-5.5.
- OpenCode: moka-test-writer/default for test-only changes; moka-code-writer/default if a production seam is required.
Escalation:
- Met: shared residual diagnostics clear with fresh parsed gate evidence.
- Unmet: record remaining unsafe fixtures, why existing public seams cannot type them, and the production seam decision needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Shared test and residual diagnostics are cleared after all domain lanes. -- Evidence: parsed oxlint JSON shows zero remaining source/test errors except final-gate residuals explicitly moved to PIPE-95.14 with rule/file/count.
- [ ] #2 Shared fixtures are typed through builders or explicit guards. -- Evidence: review names helper(s) used and added-line escape scan exits 1.
- [ ] #3 Behaviour remains covered. -- Evidence: focused Vitest files touched by this ticket pass and nub run typecheck exits 0.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Start from fresh post-domain-lane gate output, group residuals by shared helper or cross-domain fixture, introduce typed builders/guards in existing helper locations, run touched Vitest files, then rerun residual counts and typecheck.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
