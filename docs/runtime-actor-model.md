# Runtime Actor Model

The runtime actor model describes pipeline execution with stable domain events emitted directly by the runtime scheduler, node tracker, gates, and hooks.

## Actor Responsibilities

- Pipeline actor: owns a run-level system ID and final result assembly.
- Workflow actor: owns planning, workflow hooks, scheduling, fail-fast behavior, cancellation, and outcome.
- Node actor: owns node lifecycle snapshots, runner phases, gate phases, success/error hooks, retrying, and terminal node state.
- Gate actor: owns one gate evaluation, including started, finished, failed, and cancelled observability.
- Hook actor: owns one hook invocation, including required and optional failure semantics.

Actor IDs use `pipeline.<kind>.<runId>.<workflowId>.<nodeId>.<gateId|hookId>` where missing suffix parts are omitted.

## States

Workflow states: `planning`, `startingHooks`, `checkingStartHooks`, `scheduling`, `runningBatch`, `evaluatingBatch`, `failureHooks`, `failureCompleteHooks`, `successHooks`, `completeHooks`, `checkingCompleteHooks`, `cancelling`, `passed`, `failed`, `cancelled`.

Node states: `pending`, `ready`, `startingHooks`, `snapshotBefore`, `runnerStarting`, `runnerRunning`, `runnerFinished`, `outputRecording`, `snapshotAfter`, `gatesStarting`, `gatesRunning`, `gatesFinished`, `successHooks`, `retrying`, `passed`, `failed`, `cancelled`, `skipped`.

Hook states: `queued`, `running`, `passed`, `failed`, `timedOut`, `skipped`.

Gate states: `pending`, `running`, `passed`, `failed`, `timedOut`, `cancelled`.

Terminal states are `passed`, `failed`, `cancelled`, and `skipped` where the actor defines them.

## Observability

Runtime observability records are emitted directly by runtime code. CLI and console integrations consume stable domain events and existing public `PipelineRuntimeEvent` values.

Hook observability records hook started, finished, failed, timed out, and skipped events. Retry observability records retry scheduled and exhausted phases through node state. Cancellation is represented by direct cancelled events and terminal cancelled states.

## Validation

Run these checks after changing the actor model:

```sh
bun run typecheck
bun run check
bun run build
bun run test
```
