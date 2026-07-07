import { Context, Effect, Layer, Option } from "effect";

import type { WorkflowExecutionPlan } from "../planning/compile";
import type {
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeNodeResult,
} from "./contracts";
import type { RunJournal } from "./run-journal";
import { runWorkflowScheduler } from "./scheduler";
import { runWorkflowLifecycle } from "./workflow-lifecycle";
import type {
  WorkflowHookEvent,
  WorkflowHookResult,
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
  // PIPE-83.10: durability provider. Returns Some journal for crash-resume,
  // or None to run purely in-memory.
  resolveJournal: (context: RuntimeContext) => Option.Option<RunJournal>;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    context: RuntimeContext,
    failure?: RuntimeFailure
  ) => Promise<WorkflowHookResult> | WorkflowHookResult;
  shouldContinueAfterNodeResult: (
    result: RuntimeNodeResult,
    context: RuntimeContext
  ) => boolean;
  skipNode: (nodeId: string, reason: string, context: RuntimeContext) => void;
}

const LocalSchedulerOptionsService = Context.Service<LocalSchedulerOptions>(
  "LocalSchedulerOptionsService"
);

const localSchedulerOptionsLive = (options: LocalSchedulerOptions) =>
  Layer.succeed(LocalSchedulerOptionsService, options);

const scheduleNode = (
  node: WorkflowExecutionPlan["topologicalOrder"][number]
) => ({
  category: node.category,
  dependents: node.dependents,
  id: node.id,
  index: node.index,
  needs: node.needs,
});

const schedulerInput = (
  plan: WorkflowExecutionPlan,
  context: RuntimeContext,
  options: LocalSchedulerOptions
) => ({
  failFast: plan.execution.failFast,
  fanOutWidth: context.config.token_budget.fan_out_width,
  isCancelled: () => options.isCancelled(context),
  journal: Option.getOrUndefined(options.resolveJournal(context)),
  markNodeReady: (nodeId: string) => {
    options.markNodeReady(nodeId, context);
  },
  maxParallelNodes: context.maxParallelNodes,
  nodes: plan.topologicalOrder.map(scheduleNode),
  runNode: async (nodeId: string) => await options.executeNode(nodeId, context),
  shouldContinueAfterNodeResult: (result: RuntimeNodeResult) =>
    options.shouldContinueAfterNodeResult(result, context),
  skipNode: (nodeId: string, reason: string) => {
    options.skipNode(nodeId, reason, context);
  },
});

const lifecycleInput = (
  plan: WorkflowExecutionPlan,
  context: RuntimeContext,
  options: LocalSchedulerOptions
) => ({
  buildResult: options.buildResult,
  emitWorkflowPlanned: () => {
    options.emitWorkflowPlanned(context);
  },
  emitWorkflowStarted: () => {
    options.emitWorkflowStarted(context);
  },
  executeWorkflow: async () =>
    await runWorkflowScheduler(schedulerInput(plan, context, options)),
  isCancelled: () => options.isCancelled(context),
  runWorkflowHook: async (event: WorkflowHookEvent, failure?: RuntimeFailure) =>
    await options.runWorkflowHook(event, context, failure),
});

const runLocalWorkflowEffect = (
  plan: WorkflowExecutionPlan,
  context: RuntimeContext
): Effect.Effect<
  PipelineRuntimeResult,
  unknown,
  Context.Service.Identifier<typeof LocalSchedulerOptionsService>
> =>
  Effect.gen(function* effectBody() {
    const options = yield* LocalSchedulerOptionsService;
    const lifecycle = yield* Effect.tryPromise({
      catch: (error) => error,
      try: async () =>
        await runWorkflowLifecycle(lifecycleInput(plan, context, options)),
    });
    return lifecycle.result;
  });

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
    const { options } = this;
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
