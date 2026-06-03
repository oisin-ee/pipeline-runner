---
id: PIPE-40.2
title: Define runtime machine contracts and observability taxonomy
status: To Do
assignee: []
created_date: '2026-06-03 09:25'
labels:
  - xstate
  - runtime
  - observability
  - contracts
dependencies:
  - PIPE-40.1
references:
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
modified_files:
  - src/runtime-machines/contracts.ts
  - src/runtime-observability.ts
  - tests/runtime-machines-contracts.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 75000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the shared TypeScript contracts for the XState runtime actor system before any machine is implemented. This owns state names, event names, context shapes, tags, actor IDs, and the stable domain observability taxonomy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New runtime-machine contract module defines typed workflow, node, attempt, gate, hook, retry, cancellation, and terminal events without using raw any or unsafe casts.
- [ ] #2 Node state names include explicit operational phases: pending, ready, startingHooks, snapshotBefore, runnerStarting, runnerRunning, runnerFinished, outputRecording, snapshotAfter, gatesStarting, gatesRunning, gatesFinished, successHooks, retrying, passed, failed, cancelled, skipped.
- [ ] #3 Hook state names include queued, running, passed, failed, timedOut, skipped.
- [ ] #4 Typed tags include running, waiting, hook, runner, gate, retrying, terminal, failure, cancelled.
- [ ] #5 A stable domain observability event type is defined separately from XState inspection events and can represent state enter/exit, actor event, actor snapshot, hook started/finished, retry scheduled/exhausted, and node/gate lifecycle events.
- [ ] #6 Contract tests verify exhaustive state/tag/event typing through public exported types or compile-time fixtures.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/runtime-machines/contracts.ts and src/runtime-observability.ts. Keep this ticket behavior-free: no pipeline-runtime integration, no actor execution, no reporter changes.
<!-- SECTION:PLAN:END -->
