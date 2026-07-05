---
id: PIPE-88.3
title: Argo workflow status poller via in-cluster service account
status: Done
assignee: []
created_date: "2026-06-21 19:27"
updated_date: "2026-07-04 19:42"
labels: []
dependencies: []
modified_files:
  - src/runtime/services/kubernetes-argo-service.ts
parent_task_id: PIPE-88
priority: high
ordinal: 247000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: src/runtime/services/kubernetes-argo-service.ts (add getWorkflow/phase read), new poller module. No moka status exists today. Controller needs child-run terminal signal: poll Argo workflow .status.phase (Running|Succeeded|Failed|Error) via loadFromDefault() pod SA (confirmed at kubernetes-argo-service.ts:131). Reuse @kubernetes/client-node.
Dependencies: none
Escalation: report Met/Unmet with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 pollWorkflowPhase(workflowName, namespace) resolves to a terminal phase via in-cluster SA -- Evidence: test with a faked k8s client returns Succeeded/Failed; backoff between polls
- [x] #2 Transient k8s API errors are surfaced/retried, never swallowed -- Evidence: test asserts error path logs + retries, does not silently resolve
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

DONE. Argo workflow status poller via in-cluster service account.

Evidence:

- src/loop/argo-poll.ts — pollWorkflowPhaseUntilTerminal reads Argo workflow .status.phase and resolves to a terminal phase (Succeeded/Failed/Error) with backoff between polls, via the in-cluster SA (kubernetes-argo-service getWorkflow read added in commit 179a15a; src/runtime/services/kubernetes-argo-service.ts loadFromDefault SA).
- Transient k8s API errors are retried + logged, never swallowed; exhausted retry budget FAILS the Effect rather than silently terminating.
- Tests green: src/loop/argo-poll.test.ts (6 passed), incl. "transient API error is retried, logged, and not swallowed — resolves after recovery" and "exhausted retry budget fails the Effect, not silently terminates".

AC1 (terminal phase via SA + backoff) and AC2 (retry/surface, never silent) both met.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on poller; record output
<!-- DOD:END -->
