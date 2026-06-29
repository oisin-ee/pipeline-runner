---
id: PIPE-94.8
title: 'moka resume: origin-default execution, per-node executor switchable'
status: Done
assignee: []
created_date: '2026-06-28 19:52'
updated_date: '2026-06-28 22:23'
labels: []
dependencies:
  - PIPE-94.1
  - PIPE-94.4
  - PIPE-94.6
modified_files:
  - src/run-control/resume-command.ts
  - src/pipeline-runtime.ts
  - src/runtime/workflow-execution.ts
parent_task_id: PIPE-94
priority: high
ordinal: 329000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: resume reads run origin from the manifest. Local-origin -> LocalScheduler continue (current behaviour). Remote-origin -> re-submit an Argo workflow containing only the not-yet-passed nodes (passed read from store via resumeCompleted, skipped). Nodes are independent, so a node executor may be switched from the origin default (flag/override). Default = origin.
Dependencies: PIPE-94.1, PIPE-94.4 (submit createRun reusable for re-submit), PIPE-94.6 (results recorded so passed set exists)
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Resuming a remote-origin run re-submits an Argo workflow of only the remaining nodes -- Evidence: test asserts re-submitted schedule excludes passed nodes
- [ ] #2 Resuming a local-origin run continues locally (unchanged) -- Evidence: existing local resume tests green
- [ ] #3 A node can be forced to the non-origin executor -- Evidence: test exercises the per-node override
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
