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

## Node Execution Event Contract

`NodeExecutionEvent` records persist into `NodeExecutionState.status`. The persisted status values are `pending`,
`ready`, `running`, `gating`, `passed`, `failed`, `cancelled`, and `skipped`. The finer-grained node states above
remain actor and observability phases; this table is the persisted lifecycle contract owned by `NodeStateTracker`.

| Event | Allowed from | Status after record | Notes |
| --- | --- | --- | --- |
| `READY` | `pending` | `ready` | Scheduler or scheduled task claims the node before execution. |
| `STARTED` | `ready`, `running` | `running` | First attempt starts from `ready`; retry attempts start after `RETRYING`. |
| `START_HOOKS_FINISHED` | `running` | `running` | Node start hooks completed. |
| `SNAPSHOT_BEFORE_FINISHED` | `running` | `running` | Pre-run file snapshot captured. |
| `RUNNER_STARTED` | `running` | `running` | Runner process or SDK call started. |
| `RUNNER_FINISHED` | `running` | `running` | Runner evidence, exit code, and output recorded. |
| `OUTPUT_RECORDED` | `running` | `running` | Output and handoff persisted. |
| `SNAPSHOT_AFTER_FINISHED` | `running` | `running` | Post-run file diff captured. |
| `GATES_STARTED` | `running` | `gating` | Output gates started. |
| `GATES_FINISHED` | `gating` | `gating` | Gate results stored. |
| `SUCCESS_HOOKS_STARTED` | `gating` | `gating` | Declared event with no current producer; any producer starts after gates pass. |
| `RETRYING` | `running`, `gating` | `running` | Retry decision stored; exhausted retries still record before terminal failure. |
| `PASSED` | `running`, `gating` | `passed` | Terminal success from a normal attempt or remediation pass. |
| `FAILED` | `running`, `gating` | `failed` | Terminal failure from hooks, exhausted retry, or unrecovered attempt failure. |
| `CANCELLED` | `running`, `gating` | `cancelled` | Terminal cancellation observed during or after attempt work. |
| `SKIPPED` | `pending`, `ready` | `skipped` | Scheduler skips an unstarted node, normally after fail-fast failure. |

Any event not listed for the current status is invalid. Once a node reaches `passed`, `failed`, `cancelled`, or
`skipped`, no later `NodeExecutionEvent` is valid; follow-up implementation must reject the event before mutating
stored node state. Resume paths must not re-ready already-passed nodes, and skip paths must target only unstarted
nodes.

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
