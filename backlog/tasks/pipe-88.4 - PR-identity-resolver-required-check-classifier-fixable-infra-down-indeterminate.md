---
id: PIPE-88.4
title: >-
  PR identity resolver + required-check classifier
  (fixable/infra-down/indeterminate)
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
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
- [ ] #1 runId resolves to its PR number via branch convention -- Evidence: test stubs gh pr list and asserts PR number
- [ ] #2 classifier is a data table over check conclusions, not a branch ladder -- Evidence: parameterized test covers failure->fixable, cancelled/timed_out/error->infra-down, stuck/missing->indeterminate
- [ ] #3 indeterminate requires positive infra signal to ever become infra-down -- Evidence: test: stuck in_progress + no outage -> indeterminate, not infra-down
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on classifier; record output
<!-- DOD:END -->
