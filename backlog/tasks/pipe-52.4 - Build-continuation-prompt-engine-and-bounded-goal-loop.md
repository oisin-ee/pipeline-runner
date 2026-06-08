---
id: PIPE-52.4
title: Build continuation prompt engine and bounded goal loop
status: Done
assignee: []
created_date: '2026-06-08 19:00'
updated_date: '2026-06-08 20:01'
labels:
  - goal-loop
  - continuation
dependencies:
  - PIPE-52.3
references:
  - src/pipeline-runtime.ts
  - src/runtime-machines/workflow-machine.ts
  - .pipeline/prompts
modified_files:
  - src/runtime/goal-loop/continuation-prompt.ts
  - src/runtime/goal-loop/goal-loop.ts
  - src/runtime/goal-loop/goal-loop.test.ts
parent_task_id: PIPE-52
priority: high
ordinal: 149000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Generate continuation prompts from persisted goal state and add a bounded runtime loop that re-enters OpenCode when the goal is incomplete but recoverable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Continuation prompt includes original task, task refs, current schedule node context, failed gates, verifier or acceptance evidence, changed files summary, prior attempts, and exact next requirement.
- [ ] #2 Loop stops with explicit terminal states: passed, blocked, cancelled, max_continuations_reached, or no_progress_detected.
- [ ] #3 No-progress detection blocks when the same failure signature repeats without new changed files or new evidence.
- [ ] #4 Unit tests cover prompt rendering, max continuation limit, no-progress stop, cancellation, and retry after recoverable verifier failure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a continuation prompt builder module and integrate it at the workflow/runtime boundary, not inside individual profiles. Use existing XState workflow ownership and runner launch plan. Do not rely on OpenCode promptAsync in the first implementation; spawn bounded OpenCode runs through the existing runner adapter.
<!-- SECTION:PLAN:END -->
