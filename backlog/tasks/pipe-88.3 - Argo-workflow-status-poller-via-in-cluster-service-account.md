---
id: PIPE-88.3
title: Argo workflow status poller via in-cluster service account
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
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
- [ ] #1 pollWorkflowPhase(workflowName, namespace) resolves to a terminal phase via in-cluster SA -- Evidence: test with a faked k8s client returns Succeeded/Failed; backoff between polls
- [ ] #2 Transient k8s API errors are surfaced/retried, never swallowed -- Evidence: test asserts error path logs + retries, does not silently resolve
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on poller; record output
<!-- DOD:END -->
