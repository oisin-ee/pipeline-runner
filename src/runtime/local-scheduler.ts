import { Context, Effect, Layer } from "effect";
import type { WorkflowExecutionPlan } from "../planning/compile";
import type {
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeNodeResult,
} from "./contracts";
import type { RunJournal } from "./run-journal";
import { runWorkflowScheduler } from "./scheduler";
import {
  runWorkflowLifecycle,
  type WorkflowHookEvent,
} from "./workflow-lifecycle";

export interface PipelineScheduler {
  runWorkflow(
    plan: WorkflowExecutionPlan,
    context: RuntimeContext
  ): Promise<PipelineRuntimeResult>;
}

export interface LocalSchedulerOptions {
  buildResult: (
    outcome: PipelineRuntimeResult["outcome"],
    nodes: RuntimeNodeResult[],
    failure?: RuntimeFailure
  ) => PipelineRuntimeResult;
  emitWorkflowPlanned: (context: RuntimeContext) => void;
  emitWorkflowStarted: (context: RuntimeContext) => void;
  executeNode: (
    nodeId: string,
    context: RuntimeContext
  ) => Promise<RuntimeNodeResult>;
  isCancelled: (context: RuntimeContext) => boolean;
  markNodeReady: (nodeId: string, context: RuntimeContext) => void;
  // PIPE-83.10: optional durability provider. Returns the run's journal (for
  // crash-resume) or undefined to run purely in-memory (the default).
  resolveJournal?: (context: RuntimeContext) => RunJournal | undefined;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure: RuntimeFailure | undefined,
    context: RuntimeContext
  ) => Promise<RuntimeFailure | null> | RuntimeFailure | null;
  shouldContinueAfterNodeResult: (
    result: RuntimeNodeResult,
    context: RuntimeContext
  ) => boolean;
  skipNode: (nodeId: string, reason: string, context: RuntimeContext) => void;
}

class LocalSchedulerOptionsService extends Context.Service<
  LocalSchedulerOptionsService,
  LocalSchedulerOptions
>()("LocalSchedulerOptionsService") {}

function localSchedulerOptionsLive(options: LocalSchedulerOptions) {
  return Layer.succeed(LocalSchedulerOptionsService, options);
}

/**
 * The local, in-process scheduler seam. It owns workflow lifecycle hooks and
 * delegates the topological fan-out/gating loop to `runWorkflowScheduler`,
 * passing the durability journal (PIPE-83.10) through to it.
 */
export class LocalScheduler implements PipelineScheduler {
  private readonly options?: LocalSchedulerOptions;

  constructor(options?: LocalSchedulerOptions) {
    this.options = options;
  }

  async runWorkflow(
    plan: WorkflowExecutionPlan,
    context: RuntimeContext
  ): Promise<PipelineRuntimeResult> {
    const options = this.options;
    if (!options) {
      throw new Error(
        "LocalScheduler requires runtime options to run workflow"
      );
    }

    return await Effect.runPromise(
      Effect.provide(
        runLocalWorkflowEffect(plan, context),
        localSchedulerOptionsLive(options)
      )
    );
  }
}

function runLocalWorkflowEffect(
  plan: WorkflowExecutionPlan,
  context: RuntimeContext
): Effect.Effect<PipelineRuntimeResult, unknown, LocalSchedulerOptionsService> {
  return Effect.gen(function* () {
    const options = yield* LocalSchedulerOptionsService;
    const lifecycle = yield* Effect.tryPromise({
      catch: (error) => error,
      try: () => runWorkflowLifecycle(lifecycleInput(plan, context, options)),
    });
    return lifecycle.result;
  });
}

function lifecycleInput(
  plan: WorkflowExecutionPlan,
  context: RuntimeContext,
  options: LocalSchedulerOptions
) {
  return {
    buildResult: options.buildResult,
    emitWorkflowPlanned: () => options.emitWorkflowPlanned(context),
    emitWorkflowStarted: () => options.emitWorkflowStarted(context),
    executeWorkflow: () =>
      runWorkflowScheduler(schedulerInput(plan, context, options)),
    isCancelled: () => options.isCancelled(context),
    runWorkflowHook: (event: WorkflowHookEvent, failure?: RuntimeFailure) =>
      options.runWorkflowHook(event, failure, context),
  };
}

function schedulerInput(
  plan: WorkflowExecutionPlan,
  context: RuntimeContext,
  options: LocalSchedulerOptions
) {
  return {
    failFast: plan.execution.failFast,
    fanOutWidth: context.config.token_budget?.fan_out_width,
    isCancelled: () => options.isCancelled(context),
    journal: options.resolveJournal?.(context),
    markNodeReady: (nodeId: string) => options.markNodeReady(nodeId, context),
    maxParallelNodes: context.maxParallelNodes,
    nodes: plan.topologicalOrder.map(scheduleNode),
    runNode: (nodeId: string) => options.executeNode(nodeId, context),
    shouldContinueAfterNodeResult: (result: RuntimeNodeResult) =>
      options.shouldContinueAfterNodeResult(result, context),
    skipNode: (nodeId: string, reason: string) =>
      options.skipNode(nodeId, reason, context),
  };
}

function scheduleNode(node: WorkflowExecutionPlan["topologicalOrder"][number]) {
  return {
    category: node.category,
    dependents: node.dependents,
    id: node.id,
    index: node.index,
    needs: node.needs,
  };
}
