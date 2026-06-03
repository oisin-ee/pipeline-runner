---
id: PIPE-40.13
title: Remove obsolete imperative lifecycle code
status: To Do
assignee: []
created_date: '2026-06-03 09:27'
labels:
  - xstate
  - runtime
  - cleanup
dependencies:
  - PIPE-40.11
references:
  - src/pipeline-runtime.ts
  - package.json
modified_files:
  - src/pipeline-runtime.ts
  - package.json
  - bun.lock
parent_task_id: PIPE-40
priority: high
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delete runtime lifecycle code that XState now owns, including local reducers, manual retry orchestration, obsolete helper types, and dependencies that no longer serve another purpose.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/pipeline-runtime.ts no longer contains transitionNode, reduceNodeState, NodeStateEvent, executeWorkflowBatch imperative scheduling helpers, or p-retry-based node retry logic.
- [ ] #2 package.json and bun.lock no longer include p-retry if no remaining code imports it.
- [ ] #3 No compatibility shim remains unless it is required by a public API and has explicit tests proving why it must stay.
- [ ] #4 bun run typecheck, bun run check, bun run build, and bun run test pass.
- [ ] #5 Manual quality-gate review finds no unsafe casts, non-null assertions, disabled checks, swallowed errors, broad fallback defaults, or giant condition clusters introduced by the migration.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Search with rg for deleted symbols and p-retry imports. Remove dead code in the smallest set of files. Keep this as cleanup only; do not add new runtime behavior beyond deleting obsolete paths.
<!-- SECTION:PLAN:END -->
