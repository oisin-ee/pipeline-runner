---
id: PIPE-94.6
title: runner-command persists node result via stepNode (KEYSTONE)
status: Done
assignee: []
created_date: '2026-06-28 19:52'
updated_date: '2026-06-28 21:42'
labels: []
dependencies:
  - PIPE-94.1
  - PIPE-94.2
  - PIPE-94.3
  - PIPE-94.5
modified_files:
  - src/runner-command/run.ts
  - src/runtime/services/runner-command-io-service.ts
parent_task_id: PIPE-94
priority: high
ordinal: 327000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: the per-node Argo pod (src/runner-command/run.ts) stops discarding the RuntimeNodeResult. After runScheduledWorkflowTask it persists the result to DurableRunStore (store.record, via the stepNode core) AND updates node status in RunControlStore, then still returns the process exit code. Git-ref merge stays for file-state handoff; durable store becomes source of truth for status/results. Keep the live Pipeline Console event-sink stream unchanged.
Dependencies: PIPE-94.1, PIPE-94.2 (stepNode), PIPE-94.3 (db.url), PIPE-94.5 (serializes shared runner-command-io-service edits)
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A submitted node's RuntimeNodeResult is recorded in DurableRunStore -- Evidence: integration test: simulate runner-command against a store, store.get returns the result
- [ ] #2 Node status is updated in RunControlStore and moka next node advances to the dependent after the node passes -- Evidence: test: run node A, then next node returns B
- [ ] #3 Exit code behaviour unchanged (pass=0, infra=70, fail=1) -- Evidence: nodeProcessExitCode tests still green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
