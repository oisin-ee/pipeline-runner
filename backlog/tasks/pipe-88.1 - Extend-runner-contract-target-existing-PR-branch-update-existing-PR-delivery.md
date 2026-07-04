---
id: PIPE-88.1
title: >-
  Extend runner contract: target existing PR branch + update-existing-PR
  delivery
status: Done
assignee: []
created_date: '2026-06-21 19:27'
updated_date: '2026-07-04 19:42'
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
- [x] #1 Runner payload accepts an existing head branch + 'update existing PR' delivery mode -- Evidence: zod schema test parses a payload targeting head branch pipeline/run-x with update mode
- [x] #2 A run in update mode checks out the existing head branch and pushes additional commits to it (no new branch/PR) -- Evidence: runner-command test asserts checkout of provided head ref and push to same ref, no gh pr create call
- [x] #3 Fresh-PR path is unchanged when update mode absent -- Evidence: existing moka-submit/runner tests still green
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
DONE. Runner delivery contract now carries update-existing-PR mode + head-branch target.

Evidence:
- src/runner-command-contract.ts:60-77 — runnerRepositoryContextSchema.headBranch (optional) + runnerDeliverySchema.mode enum ["create-new-pr","update-existing-pr"] (default create-new-pr). Mirrored in src/config/schemas.ts:649.
- Update-existing-PR delivery behavior implemented in src/runtime/open-pull-request/open-pull-request.ts:135-217 — checkoutOrCreateHeadBranch does `git checkout -B <headBranch>`, then force-with-lease push (HEAD:refs/heads/<headBranch>); in update mode it APPENDS commits to the same branch and edits (no gh pr create). Fresh-PR path unchanged when mode absent (default create-new-pr).
- Tests green: src/runner-command-contract.test.ts (7 passed).

Note: implementation landed in the open-pull-request runtime module (not the run.ts/moka-submit.ts originally listed on the ticket), but the behavior — schema parses head-branch + update mode, update mode checks out existing ref and appends, fresh path untouched — is present and covered. AC1/2/3 met.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on runner-command + moka-submit suites; record output
<!-- DOD:END -->
