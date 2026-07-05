---
id: PIPE-92.5
title: Audit plain node lifecycle transition contract
status: Done
assignee: []
created_date: "2026-06-26 22:06"
labels: []
dependencies:
  - PIPE-92.4
references:
  - src/runtime/node-state-tracker.ts
  - src/pipeline-runtime.ts
  - tests/runtime-node-state-tracker.test.ts
  - tests/runtime-actor-contract-boundary.test.ts
  - >-
    backlog/tasks/pipe-59.2 -
    Replace-node-machine-with-plain-NodeStateTracker-and-retry-module.md
modified_files:
  - docs/runtime-actor-model.md
parent_task_id: PIPE-92
priority: medium
ordinal: 294000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: plan-scope-spec
Scope: inspect every recordNodeEvent call site, the NodeExecutionEvent union, current NodeStateTracker handler table, runtime actor docs, and PIPE-59/PIPE-69 de-xstate decisions. Produce an implementation-ready transition contract for the current plain async runtime.
Dependencies: PIPE-92.4 to reduce pipeline-runtime churn before lifecycle work
Likely modified files: backlog task notes and optionally docs/runtime-actor-model.md if stale/ambiguous lifecycle docs must be corrected
Non-goal: do not reintroduce xstate; the current tests explicitly forbid it.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Every NodeExecutionEvent has an explicit allowed-from/status-to contract, including terminal-state behaviour -- Evidence: task notes or docs contain transition table plus rg count of recordNodeEvent call sites reviewed
- [x] #2 Contract reconciles stale docs/adr-xstate-runtime-actor-system.md with current PIPE-59/PIPE-69 plain-runtime decisions -- Evidence: references and decision notes, no xstate dependency proposed
- [x] #3 Implementation slice is confirmed small enough or split further before code starts -- Evidence: updated child ticket notes or new subtasks
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

### Workflow Evidence

- Scope: `plan-scope-spec`; no production code changes.
- Inspect repo facts: reviewed tracker, runtime producers, scheduler skip/ready behaviour, runtime actor docs, stale ADR,
  PIPE-59, PIPE-59.2, PIPE-69, PIPE-92, PIPE-92.6, and focused tests.
- Assumptions:
  - `NodeExecutionEvent` governs persisted `NodeExecutionState.status`, not every fine-grained actor phase named in
    `docs/runtime-actor-model.md`.
  - Follow-up implementation should reject invalid transitions before mutating node state.
  - Historical ADR remains stale context; current decision authority is PIPE-59 and PIPE-69.
- Acceptance criteria: AC1 and AC2 are satisfied by the docs transition table plus evidence below; AC3 is satisfied by
  the PIPE-92.6 slice note.
- Doubt review: degraded self-review only; this host has no isolated reviewer, and no external model CLI was authorized.

### Repo Facts Reviewed

- `src/runtime/node-state-tracker.ts` exports the full `NodeExecutionEvent` union and `NodeStateTracker` handler table.
- `src/runtime/contracts/contracts.ts` defines persisted `NodeExecutionState.status` as `NodeStatus`: `pending`,
  `ready`, `running`, `gating`, `passed`, `failed`, `cancelled`, `skipped`.
- `src/pipeline-runtime.ts` owns the runtime producer helper; `recordNodeEvent` constructs `NodeStateTracker`, records
  an event, and writes the resulting state to `nodeStateStore`.
- `rg -c "^[[:space:]]*recordNodeEvent\\(" src/pipeline-runtime.ts` returned `19`. Reviewed producer call sites:
  `src/pipeline-runtime.ts:147`, `:325`, `:716`, `:911`, `:948`, `:1057`, `:1160`, `:1206`, `:1221`, `:1229`,
  `:1233`, `:1235`, `:1272`, `:1273`, `:1327`, `:1333`, `:1396`, `:1512`, `:1613`; helper definition reviewed at
  `src/pipeline-runtime.ts:719`.
- `SUCCESS_HOOKS_STARTED` currently has no runtime producer; `rg -n "SUCCESS_HOOKS_STARTED" src tests docs backlog/tasks`
  found only the tracker union/handler before this audit.
- `tests/runtime-node-state-tracker.test.ts` covers legal retry, pass, cancellation, and skip recording, but not illegal
  transition rejection yet.
- `tests/runtime-actor-docs.test.ts` forbids the old state-machine brand in `docs/runtime-actor-model.md`, so the
  transition table was added there without that term.

### Transition Contract

Canonical table: `docs/runtime-actor-model.md`, section `Node Execution Event Contract`.

Summary:

- `READY`: `pending` -> `ready`.
- `STARTED`: `ready` or `running` -> `running`.
- `START_HOOKS_FINISHED`, `SNAPSHOT_BEFORE_FINISHED`, `RUNNER_STARTED`, `RUNNER_FINISHED`, `OUTPUT_RECORDED`,
  `SNAPSHOT_AFTER_FINISHED`: `running` -> `running`.
- `GATES_STARTED`: `running` -> `gating`.
- `GATES_FINISHED`, `SUCCESS_HOOKS_STARTED`: `gating` -> `gating`.
- `RETRYING`: `running` or `gating` -> `running`.
- `PASSED`: `running` or `gating` -> terminal `passed`.
- `FAILED`: `running` or `gating` -> terminal `failed`.
- `CANCELLED`: `running` or `gating` -> terminal `cancelled`.
- `SKIPPED`: `pending` or `ready` -> terminal `skipped`.
- Terminal behaviour: after `passed`, `failed`, `cancelled`, or `skipped`, every later `NodeExecutionEvent` is invalid
  and must be rejected before mutation.

### Decision Notes

- `docs/adr-xstate-runtime-actor-system.md` is historical and stale for current runtime ownership.
- PIPE-59 says the machine layer was removed because it duplicated plain scheduling semantics; the remaining contract is
  direct runtime events and actor IDs, not a dependency on a state-machine library.
- PIPE-59.2 explicitly replaced the node machine with plain `NodeStateTracker` and direct retry functions.
- PIPE-69 closed the one-engine refactor: one plain async node engine with two thin frontends, no old runtime-machine
  dependency in source, metadata, or lockfile.
- This ticket proposes no xstate dependency and no second engine. PIPE-92.6 should implement the contract inside
  `NodeStateTracker` with declarative transition data plus focused tests.

### Doubt Review

CLAIM: the transition contract is implementation-ready for PIPE-92.6 and does not reopen the stale machine ADR.

WHY THIS MATTERS: PIPE-92.6 will change tracker behaviour; a vague lifecycle contract would either permit silent
terminal mutation or push legality checks back into `pipeline-runtime.ts`.

Degraded adversarial review findings:

- Potential issue: docs list fine-grained node states that are not persisted `NodeStatus` values. Resolution: the table
  explicitly scopes itself to persisted `NodeExecutionState.status`.
- Potential issue: `SUCCESS_HOOKS_STARTED` is declared but unproduced. Resolution: table marks it as declared with no
  current producer and keeps status at `gating`.
- Potential issue: terminal invalid-event handling needs exact implementation policy. Resolution: contract requires
  rejection before mutation; PIPE-92.6 owns exact error/diagnostic shape through tests.
- Potential issue: stale ADR could be read as current direction. Resolution: decision notes name it historical and cite
  PIPE-59/PIPE-69 as current authority without proposing any state-machine dependency.

Cross-model skipped: no explicit authorization to invoke an external model CLI.

<!-- SECTION:NOTES:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the plan-scope-spec workflow in order: scope -> inspect repo facts -> assumptions -> acceptance criteria -> doubt/grill review
- [x] #2 Proof checks recorded: rg -n 'recordNodeEvent|NodeStateTracker|xstate' src tests docs backlog/tasks && bun run test tests/runtime-node-state-tracker.test.ts
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

PIPE-92.5 completed as a plan-scope-spec audit only. No production code changed. The transition contract lives in
`docs/runtime-actor-model.md` under `Node Execution Event Contract`; PIPE-92.6 notes now confirm one small follow-up
implementation slice owned by `NodeStateTracker`.

Proof output summary:

- `rg -n 'recordNodeEvent|NodeStateTracker|xstate' src tests docs backlog/tasks`: exit 0; 150 matching lines; output reviewed and includes
  source producer/helper lines, focused tests, stale historical task/ADR references, and PIPE-92.5/PIPE-92.6 notes.
- `bun run test tests/runtime-node-state-tracker.test.ts`: exit 0; 1 file passed, 3 tests passed.
- Extra guard: `bun run test tests/runtime-actor-docs.test.ts`: exit 0; 1 file passed, 2 tests passed.
- Extra guard: `bun run test tests/runtime-actor-contract-boundary.test.ts`: exit 0; 1 file passed, 10 tests passed.
- Extra guard: `rg -n 'XState|xstate' docs/runtime-actor-model.md`: exit 1 with no output, confirming the runtime model
  doc avoids the forbidden brand terms.
- Extra guard: `git diff --check`: exit 0 with no whitespace errors.
<!-- SECTION:FINAL_SUMMARY:END -->
