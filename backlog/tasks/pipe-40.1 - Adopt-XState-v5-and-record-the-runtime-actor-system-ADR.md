---
id: PIPE-40.1
title: Adopt XState v5 and record the runtime actor-system ADR
status: To Do
assignee: []
created_date: '2026-06-03 09:24'
labels:
  - xstate
  - runtime
  - adr
dependencies: []
references:
  - package.json
  - bun.lock
documentation:
  - 'https://stately.ai/docs/setup'
  - 'https://stately.ai/docs/invoke'
  - 'https://stately.ai/docs/inspection'
modified_files:
  - package.json
  - bun.lock
parent_task_id: PIPE-40
priority: high
ordinal: 74000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add XState v5 as the maintained state-machine dependency and record the architectural decision that runtime lifecycle ownership moves from imperative reducers/retry loops to an XState actor system. This ticket establishes the non-reversible direction before implementation tickets fan out.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json and bun.lock include xstate at the current v5 release installed through bun.
- [ ] #2 An ADR records why XState v5 owns workflow/node/hook/gate lifecycle instead of a local reducer or p-retry loop.
- [ ] #3 The ADR states that raw XState inspection is diagnostic while stable domain runtime events remain the public observability contract.
- [ ] #4 The ADR cites the official XState v5 setup, invoke, actors, inspection, system, and tags docs.
- [ ] #5 bun run typecheck and bun run check pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Run bun add xstate. Create a Backlog decision or docs/ADR file using the repo's existing decision/documentation convention. Do not change runtime behavior in this ticket.
<!-- SECTION:PLAN:END -->
