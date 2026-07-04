---
id: PIPE-50
title: 'Epic: Stabilize direct Kubernetes runner dogfood'
status: Done
assignee: []
created_date: '2026-06-06 09:11'
updated_date: '2026-07-04 19:42'
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
- [x] #1 Every child issue from the direct runner verification has a dedicated ticket with acceptance criteria and verification evidence.
- [x] #2 Runner-related children can be drained without using pipeline-console APIs or event endpoints.
- [x] #3 A follow-up direct Kubernetes runner dogfood proves whether GitHub branch push and PR creation are reached.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Fix runtime/profile blockers first, keep release-image state explicit, then rerun direct no-console runner Jobs against Rondo feature tickets and record whether delivery is exercised.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All 6 child tickets Done and verified (PIPE-50.1–50.6). Epic acceptance satisfied:

AC#1 — every child issue from the 2026-06-06 direct-runner verification has a dedicated ticket with AC + evidence: PIPE-50.1 (release-workflow tests), 50.2 (acceptance reviewer gate JSON), 50.3 (stale runner image), 50.4 (OpenCode research-node timeout), 50.5 (no-console GitHub-delivery rerun), 50.6 (schedule-planner package schema) — all Done.

AC#2 — runner children drained without pipeline-console APIs/event endpoints: PIPE-50.5 ran two direct Kubernetes Jobs against a temporary non-console event sink (runner-events-50-5-20260606114511 in momokaya-pipeline); Secrets mounted by name only.

AC#3 — follow-up direct dogfood proves GitHub push + PR creation ARE reached: PIPE-50.5 verification records both orchestrators reaching delivery — OpenCode/RONDO-13 pushed pipeline/rondo-13 → PR oisin-ee/rondo#53; Codex/RONDO-12 pushed pipeline/rondo-12 → PR oisin-ee/rondo#54. Remaining failures were downstream Rondo acceptance-gate failures, NOT delivery failures. Runner image digest sha256:f5f8eb44… (tag :latest == :f346abd), Release run 27061338784.

Grooming pass 2026-07-04: verified against repo — subtask statuses all Done, PIPE-50.5 verification section carries the recorded Job names, image digest, and PR URLs. Closing epic.
<!-- SECTION:FINAL_SUMMARY:END -->
