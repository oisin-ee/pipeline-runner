---
id: PIPE-94.3
title: Expose db.url to runner pods + in-pod global-config reachability
status: Done
assignee: []
created_date: '2026-06-28 19:52'
updated_date: '2026-06-28 20:27'
labels: []
dependencies: []
modified_files:
  - src/remote/argo/policy.ts
  - src/remote/argo/model.ts
  - src/remote/argo/templates.ts
parent_task_id: PIPE-94
priority: high
ordinal: 324000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: runnerContainerEnv (src/remote/argo/policy.ts) injects momokaya db.url into the runner container via secretKeyRef so loadMokaDbUrl() resolves in-pod (pod is in-cluster -> reaches momokaya ClusterIP). Add the option to the Argo workflow model. CROSS-REPO: the momokaya db secret + its mount live in the infra GitOps repo; this ticket owns the moka-side env wiring and flags the GitOps secret as a dependency to land there.
Dependencies: none (code side)
Escalation: if the GitOps secret is not yet present, report blocker with the exact secret name/key needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Rendered Argo runner templates expose db.url via env secretKeyRef -- Evidence: template render test asserts the env var + secretKeyRef shape
- [ ] #2 loadMokaDbUrl resolves the injected value in a pod-like env -- Evidence: unit/integration test with the env set
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 Run focused tests fresh and record output
<!-- DOD:END -->
