---
id: PIPE-88.4
title: >-
  PR identity resolver + required-check classifier
  (fixable/infra-down/indeterminate)
status: Done
assignee: []
created_date: '2026-06-21 19:27'
updated_date: '2026-07-04 19:42'
labels: []
dependencies: []
modified_files:
  - src/loop/gh-checks.ts
parent_task_id: PIPE-88
priority: high
ordinal: 248000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: new src/loop/gh-checks.ts. Map child runId -> PR (gh pr list --head pipeline/<runId>). classifyRequiredCheck(pr) -> fixable | infra-down | indeterminate, ONE function owning the axis: conclusion:failure (lint/test/typecheck verdict)=fixable; positive infra signal (cancelled|timed_out|error conclusion, runner offline, GitHub status outage)=infra-down; no verdict AND no positive infra signal=indeterminate. Never classify a merely-stuck check as infra-down. Parse gh JSON output.
Dependencies: none
Escalation: report Met/Unmet with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 runId resolves to its PR number via branch convention -- Evidence: test stubs gh pr list and asserts PR number
- [x] #2 classifier is a data table over check conclusions, not a branch ladder -- Evidence: parameterized test covers failure->fixable, cancelled/timed_out/error->infra-down, stuck/missing->indeterminate
- [x] #3 indeterminate requires positive infra signal to ever become infra-down -- Evidence: test: stuck in_progress + no outage -> indeterminate, not infra-down
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
DONE. PR identity resolver + required-check classifier.

Evidence:
- src/loop/gh-checks.ts — resolves child runId to its PR via the pipeline/<runId> head-branch convention (gh pr list --head, JSON parsed); classifyRequiredChecks maps check conclusions through data tables, not a branch ladder:
  - CONCLUSION_CLASS_TABLE (gh-checks.ts:83): failure/action_required -> fixable; cancelled/timed_out -> infra-down.
  - COMMIT_STATUS_CLASS_TABLE (:91): error -> infra-down.
  - CLASS_PRIORITY (:100): fixable(2) > infra-down(1) > indeterminate(0); anything absent from the tables (unknown/passing/stuck in_progress) falls through to indeterminate, so a merely-stuck check is never infra-down without a positive infra signal.
- Tests green: src/loop/gh-checks.test.ts (13 passed), parameterized over failure->fixable, cancelled/timed_out/error->infra-down, stuck/missing->indeterminate, plus PR-number resolution stub.

AC1/2/3 all met.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on classifier; record output
<!-- DOD:END -->
