import { Effect, Option } from "effect";

import type { AcceptanceCriterion, RuntimeNodeResult } from "../contracts";
import type { DurableRunStore } from "../durable-store/durable-store";
import type { NextNodeEnvelope } from "../node-protocol/node-protocol";
import type { WorkflowScheduleNode } from "../scheduler";
import { computeReadyNodeIds } from "../scheduler";

/**
 * PIPE-94.2: the canonical, executor-agnostic node-stepping core shared by every
 * DAG-stepping engine — local `moka run`, the Argo runner, and the stepping CLI.
 * It owns the single path `build envelope → execute → record`, with execution
 * injected by the caller so the core never hard-codes a particular executor.
 *
 * The `next node` and `submit-result` CLI commands delegate their core logic
 * here (see `src/run-control/next-node.ts`, `src/run-control/submit-result.ts`),
 * so the envelope-build and record-write paths have real shared callers rather
 * than living as a CLI-only island.
 */

/**
 * Per-node envelope metadata: the prompt and read-only acceptance criteria the
 * executing agent receives. These are read-only to the agent (decision #7 —
 * criteria are owned by the schedule, not writable by the node's executor).
 */
export interface NodeEnvelopeMetadata {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly prompt: string;
}

/**
 * Inputs to the pure envelope-build primitives ({@link buildEnvelopeForNode},
 * {@link collectStoredResults}). Callers provide:
 * - `nodes` — the workflow graph. Each element must carry `id`, `index`,
 *   `needs`, and `dependents` — the shape {@link WorkflowScheduleNode} requires.
 *   `PlannedWorkflowNode` is a structural superset and therefore assignable.
 * - `nodeMetadata` — per-node prompt + criteria; missing entries default to
 *   empty prompt / empty criteria (graceful degradation for generated schedules
 *   without task_context).
 * - `runId` — the persisted run to query.
 * - `store` — the durable run store; Postgres owns the cross-invocation state
 *   behind the same interface used by tests.
 */
export interface NextNodeInput {
  readonly nodeMetadata: ReadonlyMap<string, NodeEnvelopeMetadata>;
  readonly nodes: WorkflowScheduleNode[];
  readonly runId: string;
  readonly store: DurableRunStore;
}

/**
 * The terminal results stored for this run, in graph order. Reads ALL recorded
 * node records (passed AND failed) so readiness sees which nodes are already
 * settled — a failed node is not re-emitted as ready, and a failed dependency
 * blocks its dependents via {@link computeReadyNodeIds}'s default check.
 */
export const collectStoredResults = (
  input: NextNodeInput
): RuntimeNodeResult[] =>
  input.nodes.flatMap((node) => {
    const record = input.store.get(input.runId, node.id);
    return Option.isSome(record) ? [record.value.result] : [];
  });

/**
 * Build the {@link NextNodeEnvelope} for a SPECIFIC node — everything that node
 * needs to execute, made explicit and serializable. Returns `undefined` when the
 * node id is absent from the graph. `upstreamOutputs` carries only the PASSED
 * outputs of the node's direct `needs` — a failed upstream has no meaningful
 * output to hand the next executor. Pure: all store reads come from `input.store`.
 */
export const buildEnvelopeForNode = (
  input: NextNodeInput,
  nodeId: string
): Option.Option<NextNodeEnvelope> => {
  const node = input.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return Option.none();
  }
  const meta = input.nodeMetadata.get(nodeId);
  const prompt = meta?.prompt ?? "";
  const criteria = meta?.criteria ? [...meta.criteria] : [];
  const passedByNodeId = new Map(
    collectStoredResults(input)
      .filter((result) => result.status === "passed")
      .map((result) => [result.nodeId, result])
  );
  const upstreamOutputs = node.needs.flatMap((needId) => {
    const result = passedByNodeId.get(needId);
    return result !== undefined
      ? [{ nodeId: needId, output: result.output }]
      : [];
  });
  return Option.some({
    criteria,
    nodeId,
    prompt,
    runId: input.runId,
    upstreamOutputs,
  });
};

/**
 * The single durable write path for a node's terminal result, keyed
 * `(runId, result.nodeId)`. Records `criteria: []` and `inputs: undefined`
 * (decision #7 — criteria are owned by the schedule, not the submitter; inputs
 * stay opaque until a future lane pins the schema). `recordSubmitResult`
 * (the submit CLI) and {@link stepNode} both route their write through here.
 */
export interface RecordNodeResultInput {
  readonly result: RuntimeNodeResult;
  readonly runId: string;
  readonly store: DurableRunStore;
}

export const recordNodeResult = (input: RecordNodeResultInput): void => {
  input.store.record(input.runId, input.result.nodeId, {
    criteria: [],
    inputs: undefined,
    result: input.result,
  });
};

/**
 * Dependencies for {@link stepNode} / {@link stepRun}: the envelope-build inputs
 * plus the injected `executeNode` — the executor-agnostic seam. Local supplies
 * its node executor, the Argo runner supplies the pod executor, tests supply a
 * fake; the core never references a concrete executor.
 */
export interface StepNodeDeps extends NextNodeInput {
  readonly executeNode: (
    envelope: NextNodeEnvelope
  ) => Promise<RuntimeNodeResult>;
}

/**
 * Execute ONE given node: build its envelope, run it through the injected
 * executor, and durably record the resulting {@link RuntimeNodeResult}. Selection
 * is the caller's concern — the Argo runner passes a `nodeId` it chose itself;
 * loop callers use {@link stepRun}. Fails when `nodeId` is absent from the graph
 * (no envelope can be built), surfacing the error rather than silently skipping.
 */
export const stepNode = (
  deps: StepNodeDeps,
  nodeId: string
): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
    const envelope = buildEnvelopeForNode(deps, nodeId);
    if (Option.isNone(envelope)) {
      return yield* Effect.fail(
        new Error(
          `Cannot step node '${nodeId}': it is not present in run ${deps.runId}'s graph.`
        )
      );
    }
    const result = yield* Effect.tryPromise({
      catch: (error) => error,
      try: async () => await deps.executeNode(envelope.value),
    });
    recordNodeResult({ result, runId: deps.runId, store: deps.store });
    return result;
  });

const stepReadyNodes = (
  deps: StepNodeDeps,
  results: RuntimeNodeResult[]
): Effect.Effect<readonly RuntimeNodeResult[], unknown> => {
  const completed = collectStoredResults(deps);
  const nodeId = computeReadyNodeIds({ completed, nodes: deps.nodes })[0];
  if (nodeId === undefined) {
    return Effect.succeed(results);
  }
  return Effect.flatMap(stepNode(deps, nodeId), (result) =>
    stepReadyNodes(deps, [...results, result])
  );
};

/**
 * Drive a run to completion for loop callers (manual CLI; could back local run):
 * pick the next ready node ({@link computeReadyNodeIds}) → {@link stepNode} →
 * repeat until no node is ready (run complete, or remaining nodes blocked by an
 * upstream failure). Selection stays separate from execution so engines that do
 * their own selection (Argo) bypass this and call {@link stepNode} directly.
 */
export const stepRun = (
  deps: StepNodeDeps
): Effect.Effect<readonly RuntimeNodeResult[], unknown> =>
  stepReadyNodes(deps, []);
