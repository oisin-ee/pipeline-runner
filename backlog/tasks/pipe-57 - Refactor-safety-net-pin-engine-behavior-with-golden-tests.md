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
Phase 0 of the one-engine refactor (see `/Users/oisin/.claude/projects/-Users-oisin-dev-oisin-pipeline/memory/refactor_one_engine.md`). Before deleting the xstate machines and reworking the scheduler, pin every behavior the refactor must preserve with golden/contract tests so later phases have a hard regression gate. The event record names and runtimeActorId format are an external contract consumed by Pipeline Console and must stay byte-identical across the refactor. The xstate layer currently owns more than event names: fail-fast capacity, skipped-node reasons, workflow hook ordering, runtimeActorId formatting, and the runtime.observability event stream consumed by Pipeline Console. This ticket adds tests only; production code changes are out of scope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A workflow scheduler behavior test proves `failFast: true` forces serial execution even when multiple root nodes are ready, preserving current `workflowNodeCapacity` behavior from `src/runtime-machines/workflow-machine.ts`.
- [ ] #2 A workflow scheduler behavior test proves fail-fast skips every unstarted node with the exact current reason string: `skipped because workflow fail_fast stopped after node '<nodeId>' failed`.
- [ ] #3 A workflow lifecycle test locks hook order for success (`workflow.start`, `workflow.success`, `workflow.complete`) and failure (`workflow.start`, `workflow.failure`, `workflow.complete`), including the current success-hook-failure behavior where failure wins before final PASS.
- [ ] #4 A golden ordered `RunnerEventRecord` sequence covers a small end-to-end run and snapshots event type names, sequence numbers, `runtime.observability` records, `actor.id`, and `actor.systemId`.
- [ ] #5 The golden explicitly locks `runtimeActorId` formats for workflow, node, gate, and hook actors: `pipeline.workflow.<runId>.<workflowId>`, `pipeline.node.<runId>.<workflowId>.<nodeId>`, `pipeline.gate.<runId>.<workflowId>.<nodeId>.<gateId>`, and `pipeline.hook.<runId>.<workflowId>[.<nodeId>].<hookId>`.
- [ ] #6 A golden full-manifest snapshot covers a representative multi-node Argo Workflow CRD, including `spec.onExit: pipeline-finalizer`, DAG task names/templates, dependency ordering, labels, mounts, finalizer args, and any retryStrategy fields once PIPE-60.3 adds them.
- [ ] #7 Schedule artifact round-trip golden tests cover generate -> parse -> compile for quick and execute baselines without relying on live model output.
- [ ] #8 Vitest coverage reporting (`@vitest/coverage-v8`) is wired into the test script or documented as a deliberate non-adoption with the exact blocker; coverage must be measured rather than guessed.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Write tests only; no production code changes. Derive every golden from current behavior on main. Put scheduler/lifecycle behavior tests near `tests/runtime-machines-workflow.test.ts` or the replacement public scheduler seam if one already exists; put event-record goldens in `tests/runner-command-contract.test.ts`; put Argo manifest goldens in `tests/argo-workflow.test.ts`; put schedule round-trip goldens in `tests/schedule-planner.test.ts`. Land this before PIPE-58 or any PIPE-59 child starts.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The original verified context remains load-bearing: the refactor replaces four xstate machines (`workflow-machine.ts`, `node-machine.ts`, `gate-machine.ts`, `hook-machine.ts`) with plain async code. Only the xstate inspection API (mapping `@xstate.*` events to `runtime.observability` records) is a real contract; all other machinery is semantic duplication of what Argo owns in production. Verified: the xstate machines do not use serializable snapshots, resumption, hierarchical states, or any xstate differentiator - just callbacks and events. The node-runner engine (gates, retries, remediation, hooks inside pods) already runs identically in both local and Argo paths via `src/runner-command/run.ts:240` calling `runScheduledWorkflowTask`. Only DAG-level scheduling (`xstate` loop vs Argo controller) differs. The owner uses two modes (autonomous tickets -> Argo jobs + hands-on dev with local CLI / devspace pod), not two semantic engines. The refactor unifies them to "one engine, two thin schedulers." The infra blocker (OpenBao/ESO auth drift preventing secret delivery, INFRA-050) is independent; delete/simplify first so there is less to debug when unblocking job spawning.

Additional inspection found seven xstate import sites, not just four machine files: `src/pipeline-runtime.ts`, `src/runtime/gates/gates.ts`, `src/runtime/hooks/hooks.ts`, and the four files under `src/runtime-machines/`. The machines do encode behavior that must not drift: ready-node scheduling, fail-fast serialization, skipped descendants, hook ordering, cancellation checks, and observability shape. These tests are the contract that lets later tickets replace xstate with plain async code without hand-waving. Do not bless accidental timestamps; either freeze time or assert stable fields only.
<!-- SECTION:NOTES:END -->
