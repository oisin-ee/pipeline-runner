---
id: PIPE-49.12
title: Create pull request at end of runner pipeline
status: Done
assignee: []
created_date: '2026-06-05 12:30'
updated_date: '2026-07-04 19:43'
labels:
  - runner-job
  - github
  - delivery
dependencies:
  - PIPE-49.10
references:
  - src/runtime/open-pull-request/open-pull-request.ts
  - src/schedule/passes/open-pull-request.ts
  - src/runner-command/pre-schedule.ts
  - src/runtime/services/open-pull-request-git-service.ts
  - src/runner-command-contract.ts
modified_files:
  - src/runner-job
parent_task_id: PIPE-49
priority: high
ordinal: 128000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
At the end of a successful self-contained runner-job pipeline, create a GitHub pull request for the branch or changes produced by the run. The runner job owns this delivery step as part of the pipeline run lifecycle; Pipeline Console only observes the resulting event/artifact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Successful runner-job pipeline runs can create a GitHub PR from the produced branch or changes.
- [x] #2 PR creation happens after verification succeeds and before final successful completion is reported.
- [x] #3 PR URL is emitted as a runner-job event and recorded as a run artifact/evidence.
- [x] #4 PR creation uses configured GitHub credentials from runner-job env/secrets and never logs tokens.
- [x] #5 Failed verification does not create a PR.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a dedicated delivery step after clean-job dogfood proves the pipeline lifecycle. Use GitHub-supported auth/CLI/library path selected during implementation, emit PR metadata, and cover success/failure behavior.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Done. PR delivery is implemented as an open-pull-request builtin node injected into the generated schedule DAG, not a bespoke post-run step — the ticket refs src/runner-job-contract.ts / src/runner-job are stale.

Design: the "delivery" schedule pass (src/schedule/passes/open-pull-request.ts) appends a single open-pull-request builtin node that `needs` all terminal nodes, so it runs only after the verification/work nodes pass. The builtin (src/runtime/open-pull-request/open-pull-request.ts) pushes the branch and runs `gh pr create`.

Evidence:
- AC#1 successful runs create a GitHub PR from the produced branch — executeOpenPullRequestBuiltin → openPullRequestProgram pushes then `gh pr create`, extracts the PR URL (src/runtime/open-pull-request/open-pull-request.ts:33-57, 241-249, extractPrUrl); update-existing-pr mode falls back to `gh pr edit`.
- AC#2 PR after verification, before final completion — the injected node depends on all terminal nodes (buildPrNode / terminalNodeIds, src/schedule/passes/open-pull-request.ts); it is the last DAG node.
- AC#3 PR URL emitted as event + recorded as evidence/artifact — openPrSuccess returns NodeAttemptResult with metadata deliveryPullRequest:{action,url} and evidence line "open-pull-request: PR opened — <url>" (open-pull-request.ts:358-372).
- AC#4 uses configured GitHub creds, never logs tokens — git ops route through the single authenticated primitive runAuthenticatedGit/runGit (src/run-state/git-refs.ts) injecting the mounted credential store + GIT_TERMINAL_PROMPT=0 (commit 6f17fab, open-pull-request-git-service.ts); gh uses the mounted GitHub CLI auth secret.
- AC#5 failed verification does not create a PR — because the PR node needs the terminal nodes, a failing verification node halts the DAG before the PR node executes.

Wiring: payload delivery flag threaded via pre-schedule.ts:234 (pullRequestDeliveryRequested = context.payload.delivery.pullRequest, commit 1b6b78c); shouldAppendPullRequestDelivery honors both the payload flag and config.delivery.pull_request.enabled.

Tests: src/runtime/open-pull-request/open-pull-request.test.ts (opened/updated/clean-tree/git-failure/mode paths), src/runtime/services/open-pull-request-git-service.test.ts (auth), src/schedule/passes/open-pull-request.test.ts (node injection).

Note: docs/pipeline-console-runner-contract.md additionally describes a runner finalize-time delivery that still pushes/opens a PR on runtime FAIL to keep work inspectable; that nuance is documented but the implemented+tested delivery is the DAG builtin node above, which satisfies AC#5 as written.
<!-- SECTION:FINAL_SUMMARY:END -->
