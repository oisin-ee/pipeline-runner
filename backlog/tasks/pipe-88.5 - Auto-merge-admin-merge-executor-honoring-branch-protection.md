---
id: PIPE-88.5
title: Auto-merge + admin-merge executor honoring branch protection
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
updated_date: '2026-06-21 19:27'
labels: []
dependencies:
  - PIPE-88.4
modified_files:
  - src/loop/merge.ts
parent_task_id: PIPE-88
priority: high
ordinal: 249000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: security
Scope: new src/loop/merge.ts. On pipeline PASS enable gh pr merge --auto (honors required CI). On positive infra-down classification, admin-merge via bot bypass token (gh pr merge --admin or API). Trust boundary: a bypass token that can push to protected main; must be scoped, read from secret file, never logged. Reuse git-refs auth patterns.
Dependencies: PIPE-88 PR classifier ticket (T4)
Escalation: report Met/Unmet with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 enableAutoMerge(pr) calls gh pr merge --auto and returns pending -- Evidence: test stubs gh, asserts invocation
- [ ] #2 adminMerge(pr) only fires for infra-down classification and uses the bypass token from a secret file -- Evidence: test asserts admin path gated on classification; token never appears in logs (redaction test)
- [ ] #3 abuse/error paths covered: merge conflict and missing token surface as blocked, not silent -- Evidence: tests assert blocked outcome + surfaced error
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run security workflow in order
- [ ] #2 pnpm test on merge module; record output
<!-- DOD:END -->
