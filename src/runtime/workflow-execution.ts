import { Effect } from "effect";
import type { PlannedWorkflowNode } from "../planning/compile";
import type {
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeNodeResult,
} from "./contracts";
import {
  emitWorkflowFinish,
  emitWorkflowPlanned,
  emitWorkflowStarted,
} from "./events";
import { dispatchHooks } from "./hooks";
import { acquireRunJournal } from "./journal-acquisition";
import { parseJsonObject } from "./json-validation";
import { LocalScheduler, type PipelineScheduler } from "./local-scheduler";
import {
  executePlannedNode,
  isCancelled,
  markNodeReady,
  recordSkippedNodeState,
} from "./node-execution";
import type { RunJournal } from "./run-journal";
import { workflowRuntimeResult } from "./runtime-results";
import {
  hydrateDependencyOutputs,
  hydrateScheduledDependencyStates,
  type ScheduledDependencyOutputs,
} from "./scheduled-dependencies";

export function runPipelineWithContext(
  context: RuntimeContext,
  dbUrl: string | undefined
): Effect.Effect<PipelineRuntimeResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const journal = yield* acquireRunJournal(context.runId, dbUrl);
      const scheduler = buildPipelineScheduler(context, journal);
      const result = yield* Effect.tryPromise(() =>
        scheduler.runWorkflow(context.plan, context)
      );
      return finishRuntime(context, result);
    })
  );
}

export function resumeRunWithContext(
  context: RuntimeContext,
  dbUrl: string | undefined
): Effect.Effect<PipelineRuntimeResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const journal = yield* acquireRunJournal(context.runId, dbUrl);
      yield* requireResumableRun(context.runId, journal);
      const scheduler = buildPipelineScheduler(context, journal);
      const result = yield* Effect.tryPromise(() =>
        scheduler.runWorkflow(context.plan, context)
      );
      return finishRuntime(context, result);
    })
  );
}

export function executeScheduledWorkflowTaskWithContext(
  context: RuntimeContext,
  nodeId: string,
  dependencyOutputs: ScheduledDependencyOutputs
): Effect.Effect<RuntimeNodeResult, unknown> {
  hydrateScheduledDependencyStates(context, nodeId);
  hydrateDependencyOutputs(context, dependencyOutputs);
  markNodeReady(context, nodeId);
  return executePlannedNode(nodeId, context);
}

function requireResumableRun(
  runId: string | undefined,
  journal: RunJournal | undefined
): Effect.Effect<void, Error> {
  if (journal === undefined) {
    return Effect.fail(
      new Error(
        `Cannot resume run '${runId ?? "<unknown>"}': no durable store is configured (set momokaya.db.url).`
      )
    );
  }
  if (journal.resumeCompleted().length === 0) {
    return Effect.fail(
      new Error(
        `Cannot resume run '${runId}': no persisted node results were found in the durable store.`
      )
    );
  }
  return Effect.void;
}

function buildPipelineScheduler(
  context: RuntimeContext,
  journal: RunJournal | undefined
): PipelineScheduler {
  return new LocalScheduler({
    buildResult: (outcome, nodes, failure) =>
      workflowRuntimeResult(context, outcome, nodes, failure),
    emitWorkflowPlanned: (nextContext) => emitWorkflowPlanned(nextContext),
    emitWorkflowStarted: (nextContext) => emitWorkflowStarted(nextContext),
    executeNode: (nodeId, nextContext) =>
      Effect.runPromise(executePlannedNode(nodeId, nextContext)),
    isCancelled: (nextContext) => isCancelled(nextContext),
    markNodeReady: (nodeId, nextContext) => markNodeReady(nextContext, nodeId),
    resolveJournal: () => journal,
    runWorkflowHook: (event, failure, nextContext) =>
      Effect.runPromise(dispatchHooksEffect(nextContext, event, failure)),
    shouldContinueAfterNodeResult: (result, nextContext) =>
      shouldContinueAfterNodeResult(result, nextContext),
    skipNode: (nodeId, reason, nextContext) =>
      recordSkippedNodeState(nextContext, nodeId, reason),
  });
}

function shouldContinueAfterNodeResult(
  result: RuntimeNodeResult,
  context: RuntimeContext
): boolean {
  if (result.status !== "failed") {
    return true;
  }
  const node = context.plan.graph.node(result.nodeId);
  return isRecoverableParallelFailure(node, result.output, context);
}

function isRecoverableParallelFailure(
  node: PlannedWorkflowNode | undefined,
  output: string,
  context: RuntimeContext
): boolean {
  if (!isParallelWithChildren(node, output)) {
    return false;
  }
  return hasOnlyDrainMergeDependents(node, context);
}

function isParallelWithChildren(
  node: PlannedWorkflowNode | undefined,
  output: string
): node is PlannedWorkflowNode {
  if (!node) {
    return false;
  }
  return node.kind === "parallel" ? parallelOutputHasChildren(output) : false;
}

function hasOnlyDrainMergeDependents(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): boolean {
  if (node.dependents.length === 0) {
    return false;
  }
  return node.dependents.every((dependentId) =>
    isDrainMergeNode(context.plan.graph.node(dependentId))
  );
}

function parallelOutputHasChildren(output: string): boolean {
  return (
    Object.keys(parseJsonObject(parseJsonObject(output).children)).length > 0
  );
}

function isDrainMergeNode(node: PlannedWorkflowNode | undefined): boolean {
  if (!node) {
    return false;
  }
  return node.kind === "builtin" ? node.builtin === "drain-merge" : false;
}

function dispatchHooksEffect(
  ...args: Parameters<typeof dispatchHooks>
): Effect.Effect<Awaited<ReturnType<typeof dispatchHooks>>, unknown> {
  return Effect.tryPromise(() => dispatchHooks(...args));
}

function finishRuntime(
  context: RuntimeContext,
  result: PipelineRuntimeResult
): PipelineRuntimeResult {
  emitWorkflowFinish(context, result.outcome);
  return result;
}
