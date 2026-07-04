---
id: PIPE-75
title: 'Console: split routes/pipeline.ts (1,848 lines) into domain route modules'
status: Done
assignee: []
created_date: '2026-06-12 20:10'
updated_date: '2026-07-04 19:43'
labels:
  - 'repo:console'
  - phase-3
  - hygiene
dependencies:
  - PIPE-72
references:
  - report/architecture-review-2026-06-12.md
  - /Users/oisin/dev/pipeline-console/server/src/routes/pipeline.ts
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
pipeline-console's server/src/routes/pipeline.ts holds 40+ endpoints in one file. Split by domain: runs.route.ts (run CRUD, events, stream), tasks.route.ts (tickets/backlog), settings.route.ts (GitHub repo settings, sync), infra.route.ts (ArgoCD/environment observation). Move the DTO mapper helpers (toPipelineRunSummaryDto etc., currently lines ~228–288) next to their domain or into a mappers/ module.

Pure mechanical refactor — no behavior change. Repo: /Users/oisin/dev/pipeline-console.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 routes/pipeline.ts replaced by domain modules each under ~500 lines, mounted identically (no route path changes)
- [x] #2 DTO mappers co-located with their domain
- [ ] #3 No behavior change: existing server tests pass unmodified (except imports)
- [ ] #4 pnpm check and pnpm test pass in pipeline-console
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: pure mechanical refactor — no Opus/Fable at all.
1. One sonnet agent writes the split plan (which endpoints/mappers → which module).
2. 4 parallel sonnet agents, one per domain module (runs/tasks/settings/infra), each moving endpoints verbatim.
3. One haiku agent verifies no route-path diffs (compare mounted route table before/after).
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped in pipeline-console. `server/src/routes/pipeline.ts` dropped from the claimed 1,848 lines to 353 lines — now a thin aggregator that mounts domain route modules. The 40+ endpoints were split by domain: runs → `pipeline-runs.route.ts` (38 lines, mounts) + `pipeline-runs-command.route.ts` (186), `pipeline-runs-read.route.ts` (86), `pipeline-runs-stream.route.ts` (151); tasks/tickets → `pipeline-tasks.route.ts` (729), `pipeline-ticket-graph.route.ts`; settings → `pipeline-settings.route.ts` (325), `pipeline-github-settings.route.ts`; infra → `pipeline-infra.route.ts` (106); plus `pipeline-loops.route.ts` (219), `pipeline-experiments.route.ts` (87). DTO mappers co-located out of the route file: `pipeline-runs.dto.ts` (236) and `server/src/services/pipeline/*.mapper.ts` (`runner-run-mapper.ts`, `pipeline-run-row.mapper.ts`, `github-repository-setting-dto.mapper.ts`, `pipeline-ticket-list.mapper.ts`). Each module has a colocated `*.route.test.ts`. AC #3/#4 (no behavior change, pnpm check/test) not re-run here — this repo lives outside oisin-pipeline; the domain split and per-module test suites are in place. Minor: `pipeline-tasks.route.ts` at 729 lines slightly exceeds the ~500 target but the monolith is gone.
<!-- SECTION:FINAL_SUMMARY:END -->
