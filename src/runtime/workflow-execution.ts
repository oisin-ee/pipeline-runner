import { Effect, Option } from "effect";

import type { PlannedWorkflowNode } from "../planning/compile";
import type { PipelineRuntimeResult, RuntimeContext, RuntimeFailure, RuntimeNodeResult } from "./contracts";
import { emitWorkflowFinish, emitWorkflowPlanned, emitWorkflowStarted } from "./events";
import { dispatchHooks } from "./hooks";
import { acquireRunJournal } from "./journal-acquisition";
import { parseJsonObject } from "./json-validation";
import { LocalScheduler } from "./local-scheduler";
import type { PipelineScheduler } from "./local-scheduler";
import { executePlannedNode, isCancelled, markNodeReady, recordSkippedNodeState } from "./node-execution";
import type { RunJournal } from "./run-journal";
import { workflowRuntimeResult } from "./runtime-results";
import { hydrateDependencyOutputs, hydrateScheduledDependencyStates } from "./scheduled-dependencies";
import type { ScheduledDependencyOutputs } from "./scheduled-dependencies";

export const executeScheduledWorkflowTaskWithContext = (
  context: RuntimeContext,
  nodeId: string,
  dependencyOutputs: ScheduledDependencyOutputs,
): Effect.Effect<RuntimeNodeResult, unknown> => {
  hydrateScheduledDependencyStates(context, nodeId);
  hydrateDependencyOutputs(context, dependencyOutputs);
  markNodeReady(context, nodeId);
  return executePlannedNode(nodeId, context);
};

const requireResumableRun = (runId?: string, journal?: RunJournal): Effect.Effect<void, Error> => {
  if (journal === undefined) {
    return Effect.fail(
      new Error(`Cannot resume run '${runId ?? "<unknown>"}': no durable store is configured (set momokaya.db.url).`),
    );
  }
  if (journal.resumeCompleted().length === 0) {
    return Effect.fail(
      new Error(`Cannot resume run '${runId}': no persisted node results were found in the durable store.`),
    );
  }
  return Effect.void;
};

const parallelOutputHasChildren = (output: string): boolean =>
  Object.keys(parseJsonObject(parseJsonObject(output).children)).length > 0;

const isParallelWithChildren = (output: string, node?: PlannedWorkflowNode): node is PlannedWorkflowNode => {
  if (!node) {
    return false;
  }
  return node.kind === "parallel" ? parallelOutputHasChildren(output) : false;
};

const isDrainMergeNode = (node?: PlannedWorkflowNode): boolean => {
  if (!node) {
    return false;
  }
  return node.kind === "builtin" ? node.builtin === "drain-merge" : false;
};

const hasOnlyDrainMergeDependents = (node: PlannedWorkflowNode, context: RuntimeContext): boolean => {
  if (node.dependents.length === 0) {
    return false;
  }
  return node.dependents.every((dependentId) => isDrainMergeNode(context.plan.graph.node(dependentId)));
};

const isRecoverableParallelFailure = (output: string, context: RuntimeContext, node?: PlannedWorkflowNode): boolean => {
  if (!isParallelWithChildren(output, node)) {
    return false;
  }
  return hasOnlyDrainMergeDependents(node, context);
};

const shouldContinueAfterNodeResult = (result: RuntimeNodeResult, context: RuntimeContext): boolean => {
  if (result.status !== "failed") {
    return true;
  }
  const node = context.plan.graph.node(result.nodeId);
  return isRecoverableParallelFailure(result.output, context, node);
};

const dispatchHooksEffect = (
  ...args: Parameters<typeof dispatchHooks>
): Effect.Effect<Option.Option<RuntimeFailure>, unknown> =>
  Effect.tryPromise(async () => await dispatchHooks(...args)).pipe(Effect.map(Option.fromNullishOr));

const buildPipelineScheduler = (context: RuntimeContext, journal?: RunJournal): PipelineScheduler =>
  new LocalScheduler({
    buildResult: (outcome, nodes, failure) => workflowRuntimeResult(context, outcome, nodes, failure),
    emitWorkflowPlanned: (nextContext) => {
      emitWorkflowPlanned(nextContext);
    },
    emitWorkflowStarted: (nextContext) => {
      emitWorkflowStarted(nextContext);
    },
    executeNode: async (nodeId, nextContext) => await Effect.runPromise(executePlannedNode(nodeId, nextContext)),
    isCancelled: (nextContext) => isCancelled(nextContext),
    markNodeReady: (nodeId, nextContext) => {
      markNodeReady(nextContext, nodeId);
    },
    resolveJournal: () => Option.fromUndefinedOr(journal),
    runWorkflowHook: async (event, nextContext, failure) =>
      await Effect.runPromise(dispatchHooksEffect(nextContext, event, failure)),
    shouldContinueAfterNodeResult: (result, nextContext) => shouldContinueAfterNodeResult(result, nextContext),
    skipNode: (nodeId, reason, nextContext) => {
      recordSkippedNodeState(nextContext, nodeId, reason);
    },
  });

const finishRuntime = (context: RuntimeContext, result: PipelineRuntimeResult): PipelineRuntimeResult => {
  emitWorkflowFinish(context, result.outcome);
  return result;
};

const skipRunValidation = (): Effect.Effect<void, unknown> => Effect.void;

const runWorkflowWithContext = (
  context: RuntimeContext,
  dbUrl: Option.Option<string>,
  validateRun: (journal: Option.Option<RunJournal>) => Effect.Effect<void, unknown> = skipRunValidation,
): Effect.Effect<PipelineRuntimeResult, unknown> =>
  Effect.scoped(
    Effect.gen(function* effectBody() {
      const journal = yield* acquireRunJournal(Option.fromUndefinedOr(context.runId), dbUrl);
      yield* validateRun(journal);
      const scheduler = buildPipelineScheduler(context, Option.getOrUndefined(journal));
      const result = yield* Effect.tryPromise(async () => await scheduler.runWorkflow(context.plan, context));
      return finishRuntime(context, result);
    }),
  );

export const runPipelineWithContext = (
  context: RuntimeContext,
  dbUrl?: string,
): Effect.Effect<PipelineRuntimeResult, unknown> => runWorkflowWithContext(context, Option.fromUndefinedOr(dbUrl));

export const resumeRunWithContext = (
  context: RuntimeContext,
  dbUrl?: string,
): Effect.Effect<PipelineRuntimeResult, unknown> =>
  runWorkflowWithContext(context, Option.fromUndefinedOr(dbUrl), (journal) =>
    requireResumableRun(context.runId, Option.getOrUndefined(journal)),
  );
