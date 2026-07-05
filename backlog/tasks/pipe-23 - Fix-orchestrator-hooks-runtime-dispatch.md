---
id: PIPE-23
title: Fix orchestrator hooks runtime dispatch
status: Done
assignee: []
created_date: "2026-05-25 13:48"
updated_date: "2026-05-25 20:32"
labels:
  - hooks
  - runtime
  - bug
dependencies:
  - PIPE-25
priority: high
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

The config schema and generated command resources support `orchestrator.hooks`, but the YAML runtime currently dispatches workflow and node hooks only. This leaves configured orchestrator hooks visible in generated host resources but ineffective during actual runtime execution.

This task must define and implement the semantics for orchestrator-level hooks in the config-driven runtime. The likely intended semantics are that orchestrator hooks are workflow-level lifecycle hooks owned by the orchestrator config: they should run for matching workflow events in addition to workflow-declared hooks, with deterministic ordering and the same required/optional failure behavior as other hooks.

Scope:

- Decide and document whether `orchestrator.hooks` are dispatched or removed/deprecated. Preferred direction: dispatch them.
- Define ordering between orchestrator hooks and workflow hooks.
- Ensure hook events emitted by PIPE-21 include orchestrator hooks with useful identifiers.
- Preserve existing workflow and node hook behavior.
- Add tests proving the selected semantics.

Non-goals:

- Do not harden hook execution security here; PIPE-22 covers trust, env, timeouts, output limits, and structured payloads.
- Do not remove hooks as a configurable concept.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Runtime dispatch includes orchestrator.hooks for documented workflow lifecycle events, or the config field is explicitly removed/deprecated.
- [x] #2 Ordering between orchestrator hooks and workflow hooks is documented and tested.
- [x] #3 Required orchestrator hook failure fails the workflow with clear evidence.
- [x] #4 Optional orchestrator hook failure is recorded without failing the workflow.
- [x] #5 Existing workflow and node hook behavior remains unchanged.
- [x] #6 Tests cover orchestrator hook success, failure, optional failure, ordering, and non-regression for node hooks.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Inspect config schema, install-command generation, and runtime dispatch to confirm current references to `orchestrator.hooks`.
2. Define ordering explicitly. Recommended: orchestrator hooks run before workflow hooks for workflow-level events, then node hooks for node-level events.
3. Update runtime hook collection so matching orchestrator hooks dispatch for workflow lifecycle events.
4. Ensure required orchestrator hook failure fails the workflow and optional failure is recorded consistently.
5. Add tests for required orchestrator hook success, required orchestrator hook failure, optional orchestrator hook failure, ordering with workflow hooks, and no regression for node hooks.
6. Update docs or generated command text if necessary so semantics match runtime behavior.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented orchestrator workflow hook dispatch with orchestrator-before-workflow ordering, duplicate hook-id dedupe, required/optional behavior preservation, lifecycle events, and regression tests.

<!-- SECTION:FINAL_SUMMARY:END -->
