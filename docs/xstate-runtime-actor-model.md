# XState Runtime Actor Model

The runtime actor system models pipeline execution with stable domain events layered over XState v5 actors.

## Actor Responsibilities

- Pipeline actor: owns a run-level system ID, root inspection, and final result assembly.
- Workflow actor: owns planning, workflow hooks, batch scheduling, fail-fast behavior, cancellation, and outcome.
- Node actor: owns node lifecycle snapshots, runner phases, gate phases, success/error hooks, retrying, and terminal node state.
- Gate actor: owns one gate evaluation, including started/finished/failed/cancelled observability.
- Hook actor: owns one hook invocation, including required and optional failure semantics.

Actor IDs use `pipeline.<kind>.<runId>.<workflowId>.<nodeId>.<gateId|hookId>` where missing suffix parts are omitted.

## States

Workflow states: `planning`, `startingHooks`, `scheduling`, `runningBatch`, `failFastStopping`, `cancelling`, `completingHooks`, `passed`, `failed`, `cancelled`.

Node states: `pending`, `ready`, `startingHooks`, `snapshotBefore`, `runnerStarting`, `runnerRunning`, `runnerFinished`, `outputRecording`, `snapshotAfter`, `gatesStarting`, `gatesRunning`, `gatesFinished`, `successHooks`, `retrying`, `passed`, `failed`, `cancelled`, `skipped`.

Hook states: `queued`, `running`, `passed`, `failed`, `timedOut`, `skipped`.

Gate states: `pending`, `running`, `passed`, `failed`, `timedOut`, `cancelled`.

Terminal states are `passed`, `failed`, `cancelled`, and `skipped` where the actor defines them.

## Observability

Raw XState inspection events are diagnostic only. The bridge maps actor creation, actor events, snapshots, and microsteps into stable runtime observability events. Snapshot payloads are redacted by default so large node or hook output does not leak through diagnostics.

CLI and console integrations consume stable domain events and existing public `PipelineRuntimeEvent` values. Raw inspection should not be used as an integration contract.

Hook observability records hook started, finished, failed, timed out, and skipped events. Retry observability records retry scheduled and exhausted phases through node actor state. Cancellation is represented by cancelled machine tags and terminal cancelled states.

## Validation

Run these checks after changing the actor system:

```sh
bun run typecheck
bun run check
bun run build
bun run test
```
