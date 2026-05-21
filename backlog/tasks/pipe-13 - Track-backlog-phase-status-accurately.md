---
id: PIPE-13
title: Track backlog phase status accurately
status: In Progress
assignee:
  - Codex
created_date: '2026-05-21 09:19'
updated_date: '2026-05-21 09:46'
labels:
  - backlog
  - workflow
dependencies:
  - PIPE-11
references:
  - src/index.ts
  - src/mastra/backlog.ts
  - src/mastra/workflows/pipeline.ts
  - tests/cli.test.ts
priority: medium
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire the pipeline phase tasks to the actual run lifecycle. The CLI currently creates research, test-write, implement, verify, and learn tasks, but only marks research in progress and learn done. Phase status should reflect the real step progression and failure point.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each phase task is marked In Progress when its corresponding step starts.
- [ ] #2 Each phase task is marked Done only when its corresponding step succeeds.
- [ ] #3 When a step fails, the corresponding phase records a failed or blocked state supported by Backlog.md, and later phases are not incorrectly marked Done.
- [ ] #4 The implementation either uses `findReadyPhase` meaningfully or removes/replaces it with tested lifecycle logic.
- [ ] #5 Tests cover phase status updates for successful and failing pipeline runs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementation plan:
1. Work in dedicated `wt` branch/worktree `pipe-13-backlog-phase-status` based on current `main`.
2. Wire phase status updates to actual lifecycle progression for research, test-write/RED, implement/GREEN, verify, and learn.
3. Mark each phase In Progress when it starts and Done only when it succeeds; on failure, use a Backlog-supported non-Done status for the failed/current phase and do not mark later phases Done.
4. Either integrate `findReadyPhase` into the lifecycle meaningfully or remove/replace it with tested lifecycle logic.
5. Add tests for successful and failing pipeline runs, then run `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`; commit scoped branch changes before handoff.
<!-- SECTION:PLAN:END -->
