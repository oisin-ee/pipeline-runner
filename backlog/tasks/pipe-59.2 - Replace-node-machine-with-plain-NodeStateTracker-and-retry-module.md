---
id: PIPE-59.2
title: Replace node-machine with plain NodeStateTracker and retry module
status: Done
assignee: []
created_date: '2026-06-11 20:38'
updated_date: '2026-06-12 10:28'
labels:
  - refactor
  - runtime
dependencies:
  - PIPE-59.1
parent_task_id: PIPE-59
priority: high
ordinal: 189000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Step 2 of de-xstate. src/runtime-machines/node-machine.ts (344 lines) is a passive status recorder: pipeline-runtime.ts does the work, sends events like SNAPSHOT_BEFORE_FINISHED purely to update a status string, then reads state back via getSnapshot() (src/pipeline-runtime.ts:533-557). The retry decision is worse: pipeline-runtime.ts:606-620 sends RETRYING into the machine so that nodeRetryDecision/retryDelayMs (pure functions at node-machine.ts:316-342) compute a result it then reads back out of the snapshot. Replace with a plain NodeStateTracker over the existing NodeExecutionState type (src/runtime/contracts/contracts.ts) and move nodeRetryDecision/retryDelayMs into a new src/runtime/retry.ts called directly. Keep the hand-rolled AbortSignal-aware waitForRetryDelay (pipeline-runtime.ts:1042-1061) - p-retry does not model the gate-failure-to-remediation flow.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 node-machine.ts is deleted; node status transitions live in a plain NodeStateTracker using the existing NodeExecutionState type.
- [x] #2 Retry policy, decision, and delay live in src/runtime/retry.ts as directly-called pure functions; the send/getSnapshot round-trips in pipeline-runtime.ts are gone.
- [x] #3 Retry behavior (attempt counts, backoff multiplier, gate-failure retries) is unchanged per existing tests.
- [x] #4 `waitForRetryDelay` remains AbortSignal-aware and is not replaced with p-retry or a generic retry helper.
- [x] #5 Node observability emits keep the same actor IDs and payload fields through the contracts extracted by PIPE-59.5.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create `src/runtime/retry.ts` with direct exports for retry decision and delay calculation, then replace the `send(RETRYING)` / `getSnapshot()` round trip in `src/pipeline-runtime.ts` with direct calls. Introduce NodeStateTracker in the runtime layer using the existing `NodeExecutionState` contract. Move node-machine behavioral tests to the new retry/tracker modules before deleting `src/runtime-machines/node-machine.ts`. Run focused node retry tests, pipeline-runtime tests that cover gate-failure remediation, PIPE-57 goldens, and typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 2 of de-xstate: eliminate the send/getSnapshot anti-pattern. node-machine.ts (344 lines) does passive recording: pipeline-runtime.ts sends SNAPSHOT_BEFORE_FINISHED, the machine updates a status string, then pipeline-runtime reads getSnapshot(). Worse: retry decision. pipeline-runtime.ts:606-620 sends RETRYING, the machine calls the pure functions nodeRetryDecision/retryDelayMs (which should be direct calls), computes delay/attempts, and stores in snapshot context for pipeline-runtime to read back. Create a plain NodeStateTracker using the existing NodeExecutionState type (already in runtime/contracts/contracts.ts, with id/status/attempts/evidence/gates fields). Move nodeRetryDecision/retryDelayMs to src/runtime/retry.ts as direct function exports. Keep the 20-line waitForRetryDelay with AbortSignal - p-retry does not model the gate-failure-to-remediation-reprompt flow.

The tracker is a state recorder, not a second execution engine. Do not add workflow scheduling, Argo behavior, or compatibility snapshots in this ticket.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
