---
id: PIPE-50
title: 'Epic: Stabilize direct Kubernetes runner dogfood'
status: To Do
assignee: []
created_date: '2026-06-06 09:11'
labels:
  - epic
  - runner-job
  - kubernetes
  - dogfood
dependencies: []
references:
  - src/config.ts
  - src/runner-job/k8s.ts
  - .github/workflows/publish.yml
priority: high
ordinal: 129000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track the issues found by the 2026-06-06 no-console direct Kubernetes runner-job verification against Rondo tickets RONDO-12 and RONDO-13. The run used ghcr.io/oisin-ee/pipeline-runner:4fe9b7dd16c9961e493d2e3a7da39925bf647917 and a temporary non-console event receiver in momokaya-pipeline. Both Jobs mounted the expected Codex, OpenCode, GitHub, image pull, and event auth Secrets, but both failed before GitHub delivery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every child issue from the direct runner verification has a dedicated ticket with acceptance criteria and verification evidence.
- [ ] #2 Runner-related children can be drained without using pipeline-console APIs or event endpoints.
- [ ] #3 A follow-up direct Kubernetes runner dogfood proves whether GitHub branch push and PR creation are reached.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Fix runtime/profile blockers first, keep release-image state explicit, then rerun direct no-console runner Jobs against Rondo feature tickets and record whether delivery is exercised.
<!-- SECTION:PLAN:END -->
