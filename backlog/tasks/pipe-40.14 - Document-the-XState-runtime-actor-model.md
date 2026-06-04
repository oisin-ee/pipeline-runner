---
id: PIPE-40.14
title: Document the XState runtime actor model
status: Done
assignee: []
created_date: '2026-06-03 09:27'
updated_date: '2026-06-04 09:22'
labels:
  - xstate
  - runtime
  - docs
  - observability
dependencies:
  - PIPE-40.12
  - PIPE-40.13
references:
  - src/pipeline-runtime.ts
modified_files:
  - docs/xstate-runtime-actor-model.md
parent_task_id: PIPE-40
priority: medium
ordinal: 87000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document the final XState actor system so future implementers and operators understand the explicit states, actor hierarchy, hooks, inspection bridge, and stable observability contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Documentation lists pipeline, workflow, node, gate, and hook actor responsibilities and systemId naming rules.
- [x] #2 Documentation lists explicit node, hook, gate, and workflow states and explains which states are terminal.
- [x] #3 Documentation explains raw XState inspection versus stable domain runtime events and states which one CLI/console integrations consume.
- [x] #4 Documentation explains hook observability, retry observability, cancellation observability, and redaction behavior for large outputs.
- [x] #5 Documentation includes commands for validating the implementation: bun run typecheck, bun run check, bun run build, bun run test.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add or update a docs/backlog decision document consistent with the repo's documentation convention. Do not modify runtime behavior in this ticket.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Documented the final XState runtime actor model, including actor responsibilities, states, inspection versus stable events, observability, cancellation, redaction, and validation commands. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.
<!-- SECTION:FINAL_SUMMARY:END -->
