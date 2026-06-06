---
id: PIPE-50.5
title: Rerun no-console direct runner dogfood through GitHub delivery
status: To Do
assignee: []
created_date: '2026-06-06 09:12'
updated_date: '2026-06-06 10:18'
labels:
  - runner-job
  - kubernetes
  - github
  - dogfood
  - verification
dependencies:
  - PIPE-50.2
  - PIPE-50.3
  - PIPE-50.4
  - PIPE-50.6
references:
  - src/runner-job/k8s.ts
  - src/runner-job/delivery.ts
modified_files:
  - tests/runner-job-k8s.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 134000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-06-06 direct runner Jobs proved current image startup, file-mounted payloads, auth Secret mounts, Kueue admission, event posting to a non-console sink, schedule generation, and OpenCode workflow node execution. They did not prove GitHub branch push or `gh pr create`: earlier Jobs failed before delivery, and PIPE-50.6 verification ran with `delivery.pullRequest: false` and later failed at Rondo acceptance gates. After the runner blockers are fixed, rerun Codex and OpenCode direct Kubernetes Jobs against Rondo feature tickets without pipeline-console and verify delivery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two direct Kubernetes runner Jobs are created without pipeline-console APIs or event endpoints: one codex orchestrator and one opencode orchestrator.
- [ ] #2 Both Jobs use a verified current GHCR runner image digest and mount codex-auth-1, opencode-auth-1, oisin-bot-github-auth, ghcr-pull-secret, and pipeline-runner-event-auth by name without reading Secret data.
- [ ] #3 At least one successful runner pipeline reaches delivery and proves GitHub auth by pushing a pipeline/* branch and creating or updating a PR with gh.
- [ ] #4 The run records Job names, image digest, event sink evidence, branch/PR evidence, and any remaining failure phase.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create a temporary non-console event receiver, create two direct runner Jobs from the package manifest builder using the verified current image, wait for terminal state, check branch/PR evidence, then delete temporary receiver and payload ConfigMaps.
<!-- SECTION:PLAN:END -->
