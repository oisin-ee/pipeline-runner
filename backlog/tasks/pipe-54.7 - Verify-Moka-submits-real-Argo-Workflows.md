---
id: PIPE-54.7
title: Verify Moka submits real Argo Workflows
status: To Do
assignee: []
created_date: '2026-06-10 14:10'
updated_date: '2026-06-11 15:24'
labels:
  - momokaya
  - verification
  - argo
dependencies:
  - PIPE-54.5
  - PIPE-54.6
  - PIPE-54.8
references:
  - tests/cli.test.ts
  - tests/argo-submit.test.ts
  - tests/argo-workflow.test.ts
  - Dockerfile
parent_task_id: PIPE-54
priority: high
ordinal: 171000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prove the Moka command shape through real repository usage and real Argo Workflow submission, not only isolated unit tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `npm run check`, `npm run typecheck`, `npm test`, and `npm run build` pass
- [ ] #2 `fallow audit --gate new-only --include-entry-exports` reports zero introduced dead code, complexity, and duplication
- [ ] #3 Built CLI help shows `moka submit` and does not show old user-facing quick/execute/argo submit-command routes
- [ ] #4 A disposable local Kubernetes cluster with Argo installed accepts `moka submit "build the feature"` and produces a Workflow DAG
- [ ] #5 The same cluster accepts `moka submit --quick "fix this"` and produces a Workflow DAG
- [ ] #6 The same cluster accepts `moka submit --command -- codex -p "fix"` and produces a one-task Workflow DAG with runner-command args
- [ ] #7 Cluster inspection confirms no Kubernetes Job resources are created by these paths
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the repository verification standard. Build the package, run the installed/built CLI, create a disposable k3d or equivalent local cluster, install Argo Workflows, submit full/quick/command paths with real manifests, inspect Workflow specs, and delete the cluster. Do not publish locally.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Not complete. Command-mode submission was accepted by a disposable Argo cluster, but full/quick generated graph submissions exposed unsupported non-command node kinds. The fake builtin/group/parallel lowering was removed; proper graph lowering remains required.
<!-- SECTION:FINAL_SUMMARY:END -->
