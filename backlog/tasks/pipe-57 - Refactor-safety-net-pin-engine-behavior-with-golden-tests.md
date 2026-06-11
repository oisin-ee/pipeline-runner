---
id: PIPE-57
title: 'Refactor safety net: pin engine behavior with golden tests'
status: To Do
assignee: []
created_date: '2026-06-11 20:37'
updated_date: '2026-06-11 20:39'
labels:
  - refactor
  - tests
  - runtime
dependencies: []
priority: high
ordinal: 185000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 0 of the one-engine refactor (see ~/.claude/plans/i-d-like-you-to-replicated-widget.md). Before deleting the xstate machines and reworking the scheduler, pin every behavior the refactor must preserve with golden/contract tests so later phases have a hard regression gate. The event record names and runtimeActorId format are an external contract consumed by Pipeline Console and must stay byte-identical across the refactor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test asserts that failFast forces serial scheduling (workflowNodeCapacity behavior, src/runtime-machines/workflow-machine.ts:562-567), so the replacement scheduler cannot silently change it.
- [ ] #2 A golden full-manifest snapshot test covers a compiled Argo Workflow CRD for a representative multi-node plan (extends tests/argo-workflow.test.ts).
- [ ] #3 A golden ordered RunnerEventRecord sequence test covers a small end-to-end run, locking event type names, sequence numbering, and runtimeActorId format (extends tests/runner-command-contract.test.ts).
- [ ] #4 Schedule artifact round-trip golden tests cover generate -> parse -> compile for quick and execute baselines (extends tests/schedule-planner.test.ts).
- [ ] #5 Vitest coverage reporting (@vitest/coverage-v8) is wired into the test script so coverage is measured rather than guessed.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Write tests only; no production code changes. Derive the golden fixtures from current behavior on main. Land before any Phase 1+ change merges.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The refactor replaces four xstate machines (workflow-machine.ts 657 lines, node-machine.ts 344, gate-machine.ts 182, hook-machine.ts 219 = ~1,850 total) with plain async code. Only the xstate inspection API (mapping @xstate.* events to runtime.observability records) is a real contract; all other machinery is semantic duplication of what Argo owns in production. Verified: the xstate machines do not use serializable snapshots, resumption, hierarchical states, or any xstate differentiator - just callbacks and events. The node-runner engine (gates, retries, remediation, hooks inside pods) already runs identically in both local and Argo paths via src/runner-command/run.ts:240 calling runScheduledWorkflowTask. Only DAG-level scheduling (xstate loop vs Argo controller) differs. The owner uses two modes (autonomous tickets -> Argo jobs + hands-on dev with local CLI / devspace pod), not two semantic engines. The refactor unifies them to "one engine, two thin schedulers." The infra blocker (OpenBao/ESO auth drift preventing secret delivery, INFRA-050) is independent; we delete/simplify first so there is less to debug when unblocking job spawning.
<!-- SECTION:NOTES:END -->
