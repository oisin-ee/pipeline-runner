---
id: PIPE-88.1
title: >-
  Extend runner contract: target existing PR branch + update-existing-PR
  delivery
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
labels: []
dependencies: []
modified_files:
  - src/runner-command-contract.ts
  - src/moka-submit.ts
  - src/runner-command/run.ts
parent_task_id: PIPE-88
priority: high
ordinal: 245000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: src/runner-command-contract.ts (runnerDeliverySchema, runnerRepositoryContextSchema), src/moka-submit.ts (delivery wiring), src/runner-command/run.ts (branch checkout/push). LEAD SPIKE: today delivery is fresh-PR-shaped (delivery:{pullRequest:boolean}); repository allows sha pin but no head-branch target. Remediation runs must push fix-commits onto the SAME existing PR branch (pipeline/<runId>) instead of opening a new PR each iteration.
Dependencies: none
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runner payload accepts an existing head branch + 'update existing PR' delivery mode -- Evidence: zod schema test parses a payload targeting head branch pipeline/run-x with update mode
- [ ] #2 A run in update mode checks out the existing head branch and pushes additional commits to it (no new branch/PR) -- Evidence: runner-command test asserts checkout of provided head ref and push to same ref, no gh pr create call
- [ ] #3 Fresh-PR path is unchanged when update mode absent -- Evidence: existing moka-submit/runner tests still green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on runner-command + moka-submit suites; record output
<!-- DOD:END -->
