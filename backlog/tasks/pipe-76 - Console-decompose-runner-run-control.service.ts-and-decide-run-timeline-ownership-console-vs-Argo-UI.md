---
id: PIPE-76
title: >-
  Console: decompose runner-run-control.service.ts and decide run-timeline
  ownership (console vs Argo UI)
status: To Do
assignee: []
created_date: '2026-06-12 20:10'
updated_date: '2026-06-12 20:16'
labels:
  - 'repo:console'
  - phase-3
  - architecture
dependencies:
  - PIPE-75
  - PIPE-81
references:
  - report/architecture-review-2026-06-12.md
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-run-control.service.ts
priority: medium
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
server/src/services/pipeline/runner-run-control.service.ts (2,309 lines) handles run lifecycle AND manually reconstructs run detail/timeline views from raw runner events and Argo snapshots.

Two parts:
1. Decision first: Argo Workflows' own UI/API already provides per-node timelines and log streaming for Argo-executed runs. Decide whether the console keeps full timeline reconstruction or keeps only the summary view and deep-links to the Argo UI for forensics. Write the decision into the task notes before refactoring.
2. Decompose accordingly: extract RunDetailBuilder / RunTimelineBuilder (or delete reconstruction paths the decision makes obsolete), leaving the service as lifecycle orchestration only.

Note: if the Hatchet spike (see spike task) results in a go, the timeline reconstruction is deleted wholesale — so do the decision cheaply and don't gold-plate. Repo: /Users/oisin/dev/pipeline-console.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Written decision on timeline ownership (console-rendered vs Argo UI deep-link) recorded in the task
- [ ] #2 runner-run-control.service.ts reduced to lifecycle orchestration; detail/timeline building extracted or deleted per the decision
- [ ] #3 No regression in the run detail page for a live run (manual verification against a real run)
- [ ] #4 pnpm check and pnpm test pass in pipeline-console
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: decision-then-mechanics.
1. Timeline-ownership decision (console-rendered vs Argo UI deep-link, informed by PIPE-81 outcome) — model=opus, single short analysis, written to task notes.
2. Decomposition/deletion per the decision — model=sonnet, parallelizable per extracted builder once boundaries are drawn.
Don't gold-plate: if PIPE-81 was a go, this is mostly deletion — haiku can handle the dead-code removal lanes.
<!-- SECTION:PLAN:END -->
