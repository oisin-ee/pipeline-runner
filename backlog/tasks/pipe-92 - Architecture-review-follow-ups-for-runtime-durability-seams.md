---
id: PIPE-92
title: Architecture review follow-ups for runtime durability seams
status: To Do
assignee: []
created_date: '2026-06-26 22:04'
updated_date: '2026-06-26 22:07'
labels:
  - epic
  - architecture
  - refactor
dependencies: []
references:
  - >-
    /var/folders/_v/3vzdptt941qblmgyksy53g780000gn/T/architecture-review-20260627-004757.html
  - src/run-control/runtime-reporter.ts
  - src/run-control/supervisor.ts
  - src/runtime/durable-store/postgres/postgres-store.ts
  - src/pipeline-runtime.ts
  - src/runtime/node-state-tracker.ts
  - 'https://effect.website/docs/concurrency/queue/'
  - 'https://effect.website/docs/concurrency/semaphore/'
  - 'https://vitest.dev/api/describe#describe-each'
  - 'https://github.com/sindresorhus/p-queue'
priority: high
ordinal: 289000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: plan-scope-spec
Scope: Re-review /var/folders/_v/3vzdptt941qblmgyksy53g780000gn/T/architecture-review-20260627-004757.html and turn only surviving recommendations into dispatch-ready child tickets.
Dependencies: none
Likely modified files: child tickets only

Problem: The original architecture review is stale and partially landed around PIPE-91 run-control durability. Scope accepts C1/C4/C5 in revised form, rejects C6 for now, treats C2 as already implemented, and rewrites C3 away from stale XState ADR language toward the current plain async runtime.

Non-goals: do not re-add xstate; do not split run-control commands without a proven reuse seam; do not duplicate active PIPE-91.14 writer cutover work.

Escalation: child tickets report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All child tickets are Done with per-criterion evidence
<!-- DOD:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reviewed plan claims are classified as accepted/revised/rejected/already-done -- Evidence: final research summary cites repo facts and sources
- [ ] #2 Backlog child tickets cover only surviving implementation work, each with workflow route, AC, DoD, deps, likely files, and proof commands -- Evidence: PIPE-92 child task files
- [ ] #3 Dependency graph avoids same-batch write collisions for runtime-reporter.ts and pipeline-runtime.ts -- Evidence: backlog sequence list --plain batch summary
<!-- AC:END -->
