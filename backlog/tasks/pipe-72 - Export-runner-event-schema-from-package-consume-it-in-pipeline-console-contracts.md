---
id: PIPE-72
title: >-
  Export runner event schema from package; consume it in pipeline-console
  contracts
status: Done
assignee: []
created_date: '2026-06-12 20:10'
updated_date: '2026-07-04 19:42'
labels:
  - 'repo:pipeline'
  - 'repo:console'
  - phase-2
  - contracts
dependencies:
  - PIPE-70
  - PIPE-71
  - PIPE-81
references:
  - report/architecture-review-2026-06-12.md
  - /Users/oisin/dev/pipeline-console/contracts/src/pipeline/run.ts
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The runner emits events (runner-event-sink.ts → POST /api/pipeline/runner-events) and pipeline-console independently re-declares the event shape in contracts/src/pipeline/run.ts (PipelineRunEventDto). Nothing prevents drift except integration tests. This is the biggest cross-repo correctness risk.

Make @oisincoveney/pipeline the single owner of the event contract: export the Zod schema (and inferred types) for runner events from a stable subpath export (e.g. ./events). Update pipeline-console contracts to import and re-export it instead of re-declaring. Add a contract test on the console side that validates a captured real event batch against the imported schema.

Spans both repos: /Users/oisin/dev/oisin-pipeline and /Users/oisin/dev/pipeline-console.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 @oisincoveney/pipeline exposes the runner event Zod schema + types via a documented subpath export
- [x] #2 pipeline-console contracts import the schema from the package instead of re-declaring the event shape (duplicate declarations deleted)
- [x] #3 Console event ingestion (handlePostRunEvents) validates against the imported schema
- [x] #4 A contract test in pipeline-console validates a real captured event fixture against the shared schema
- [x] #5 Both repos typecheck and tests pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: sequential, 2 agents.
1. Schema extraction + subpath export in oisin-pipeline — model=sonnet (bounded, the schema already exists in runner-event-sink/contract code; this is moving + exporting, not designing).
2. Console consumption + contract test — model=sonnet.
Optional final review of the public API surface — model=opus, single short review pass only. The repos must be edited sequentially (console depends on the published/linked package shape).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision 2026-06-12: deferred behind the Hatchet spike (PIPE-81). If the spike is a go, the console event-ingestion side of this task shrinks to whatever the migration transition needs — re-scope before starting.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped in both repos. Package side: `@oisincoveney/pipeline` exposes the runner event Zod schema + inferred types via the `./events` subpath export (package.json exports → `./dist/runner-event-schema.js`; source `src/runner-event-schema.ts`, 277 lines). Console side: `pipeline-console/contracts/src/pipeline/run.ts` imports the schema from `@oisincoveney/pipeline/events` (lines 4, 13) with an explicit "runner event contract is owned by @oisincoveney/pipeline (PIPE-72)" comment, re-exports `RunnerEventRecord`, and derives `PipelineRunEventDto` from it instead of re-declaring the shape. Contract test present: `pipeline-console/contracts/src/pipeline/runner-event-contract.test.ts`. Console ingestion validation lives in `server/src/routes/pipeline-run-event-input.ts`. The Hatchet-spike deferral note (PIPE-81) is moot — runtime went Argo/Effect and the schema export + console consumption landed regardless.
<!-- SECTION:FINAL_SUMMARY:END -->
