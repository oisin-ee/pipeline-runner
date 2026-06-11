---
id: PIPE-58
title: Delete dead code and consolidate duplicated helpers
status: To Do
assignee: []
created_date: '2026-06-11 20:37'
updated_date: '2026-06-11 20:39'
labels:
  - refactor
  - cleanup
dependencies:
  - PIPE-57
priority: high
ordinal: 186000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of the one-engine refactor: quick wins that shrink surface before the structural work. Verified facts: src/toml.ts has zero importers and is not a package export; uniqueStrings/unique is implemented four times (src/workflow-planner.ts:573, src/runtime-machines/workflow-machine.ts:603, src/runtime/goal-state/goal-state.ts:500, src/argo-graph.ts); findPlannedNode is duplicated verbatim in src/pipeline-runtime.ts:223 and src/runner-command/run.ts:306; JSON-parse-with-fallback helpers exist in three places (src/safe-json.ts, src/runtime/gates/gates.ts, src/runner-command/task-descriptor.ts). Note: do NOT delete runtime/goal-loop or runtime/goal-state here - they are published package exports; their removal is a separate owner decision (see the dedicated ticket).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/toml.ts is deleted and nothing references it.
- [ ] #2 A single uniqueStrings helper (e.g. in a small src/collections.ts) replaces all four copies; all call sites updated.
- [ ] #3 findPlannedNode exists once and is imported by both src/pipeline-runtime.ts and src/runner-command/run.ts.
- [ ] #4 JSON parse helpers are consolidated into src/safe-json.ts and the duplicate implementations are removed.
- [ ] #5 bun run check and the full vitest suite pass; no public package export paths change.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fast-moving cleanup pass before structural refactor (Phase 2). Deleting toml.ts and consolidating four uniqueStrings copies, two findPlannedNode duplicates, and three JSON-parse helpers removes ~150 lines without touching the machines. These are confirmed dead/duped via grep and import analysis. Goal: visible progress, reduced surface area, and a clean base for Phase 2 machine deletion. Rule: do NOT touch runtime/goal-loop or runtime/goal-state even though they have zero production importers - they are published exports (./runtime/goal-loop, ./runtime/goal-state in package.json) and may be consumed by Pipeline Console; their removal requires explicit owner decision via a separate ticket (see PIPE-65 TODO).
<!-- SECTION:NOTES:END -->
