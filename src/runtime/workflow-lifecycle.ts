import { Effect, Option } from "effect";

import type { PipelineRuntimeResult, RuntimeFailure, RuntimeNodeResult } from "./contracts";

export type WorkflowHookEvent = "workflow.complete" | "workflow.failure" | "workflow.start" | "workflow.success";

export interface WorkflowExecutionResult {
  completed: RuntimeNodeResult[];
  failure?: RuntimeFailure;
  outcome: PipelineRuntimeResult["outcome"];
}

export type WorkflowHookResult = Option.Option<RuntimeFailure>;

export interface WorkflowLifecycleInput {
  buildResult: (
    outcome: PipelineRuntimeResult["outcome"],
    nodes: RuntimeNodeResult[],
    failure?: RuntimeFailure,
  ) => PipelineRuntimeResult;
  emitWorkflowPlanned: () => void;
  emitWorkflowStarted: () => void;
  executeWorkflow: () => Promise<WorkflowExecutionResult>;
  isCancelled?: () => boolean;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure?: RuntimeFailure,
  ) => Promise<WorkflowHookResult> | WorkflowHookResult;
}

export type WorkflowStartLifecycleInput = Pick<
  WorkflowLifecycleInput,
  "emitWorkflowPlanned" | "emitWorkflowStarted" | "runWorkflowHook"
>;

export interface WorkflowLifecycleResult {
  failure?: RuntimeFailure;
  result: PipelineRuntimeResult;
  status: "cancelled" | "failed" | "passed";
  successHookFailure?: RuntimeFailure;
}

export type WorkflowFinalizationInput = Pick<WorkflowLifecycleInput, "buildResult" | "isCancelled" | "runWorkflowHook">;

const NO_WORKFLOW_HOOK_FAILURE: WorkflowHookResult = Option.none();

const runHookEffect = (
  input: Pick<WorkflowLifecycleInput, "runWorkflowHook">,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure,
): Effect.Effect<WorkflowHookResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await input.runWorkflowHook(event, failure),
  });

const executeWorkflowEffect = (
  input: Pick<WorkflowLifecycleInput, "executeWorkflow">,
): Effect.Effect<WorkflowExecutionResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await input.executeWorkflow(),
  });

const workflowLifecycleStatus = (outcome: PipelineRuntimeResult["outcome"]): WorkflowLifecycleResult["status"] => {
  if (outcome === "CANCELLED") {
    return "cancelled";
  }
  if (outcome === "FAIL") {
    return "failed";
  }
  return "passed";
};

const finalize = (
  input: WorkflowFinalizationInput,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure,
): WorkflowLifecycleResult => {
  const status = workflowLifecycleStatus(outcome);
  return {
    ...(failure === undefined ? {} : { failure }),
    result: input.buildResult(outcome, nodes, failure),
    status,
  };
};

const hookFailureResult = (
  input: WorkflowFinalizationInput,
  nodes: RuntimeNodeResult[],
  hookFailure: RuntimeFailure,
  successHookFailure?: RuntimeFailure,
): WorkflowLifecycleResult => ({
  ...(successHookFailure === undefined ? {} : { successHookFailure }),
  failure: hookFailure,
  result: input.buildResult("FAIL", nodes, hookFailure),
  status: "failed",
});

const isWorkflowCancelled = (input: WorkflowFinalizationInput): boolean => input.isCancelled?.() ?? false;

const hookRuntimeFailure = (error: unknown): RuntimeFailure => {
  const reason =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  return { evidence: [reason], gate: "workflow.hook", reason };
};

const runHook = (
  input: Pick<WorkflowLifecycleInput, "runWorkflowHook">,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure,
): Effect.Effect<WorkflowHookResult> =>
  Effect.match(runHookEffect(input, event, failure), {
    onFailure: (error) => Option.some(hookRuntimeFailure(error)),
    onSuccess: (result) => result,
  });

const runWorkflowStartLifecycleEffect = (
  input: WorkflowStartLifecycleInput,
): Effect.Effect<WorkflowHookResult, unknown> =>
  Effect.gen(function* effectBody() {
    yield* Effect.try({
      catch: (error) => error,
      try: input.emitWorkflowPlanned,
    });
    yield* Effect.try({
      catch: (error) => error,
      try: input.emitWorkflowStarted,
    });
    return yield* runHook(input, "workflow.start");
  });

export const runWorkflowStartLifecycle = async (input: WorkflowStartLifecycleInput): Promise<WorkflowHookResult> =>
  await Effect.runPromise(runWorkflowStartLifecycleEffect(input));

const finalizePassedWorkflow = (
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult,
): Effect.Effect<WorkflowLifecycleResult> =>
  Effect.gen(function* effectBody() {
    const successHookFailure = yield* runHook(input, "workflow.success");
    const completeFailure = yield* runHook(input, "workflow.complete", Option.getOrUndefined(successHookFailure));
    const hookFailure = Option.orElse(completeFailure, () => successHookFailure);
    if (Option.isSome(hookFailure)) {
      return hookFailureResult(
        input,
        execution.completed,
        hookFailure.value,
        Option.getOrUndefined(successHookFailure),
      );
    }
    if (isWorkflowCancelled(input)) {
      return finalize(input, "CANCELLED", execution.completed);
    }
    return finalize(input, "PASS", execution.completed);
  });

const runHookError = (
  input: WorkflowFinalizationInput,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure,
): Effect.Effect<WorkflowHookResult> =>
  Effect.match(runHookEffect(input, event, failure), {
    onFailure: (error) => Option.some(hookRuntimeFailure(error)),
    onSuccess: () => NO_WORKFLOW_HOOK_FAILURE,
  });

const workflowFailure = (): RuntimeFailure => ({
  evidence: ["workflow failed without a specific failure"],
  gate: "workflow",
  reason: "workflow failed",
});

const finalizeFailedWorkflow = (
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult,
): Effect.Effect<WorkflowLifecycleResult> =>
  Effect.gen(function* effectBody() {
    const failure = execution.failure ?? workflowFailure();
    const failureHookError = yield* runHookError(input, "workflow.failure", failure);
    if (Option.isSome(failureHookError)) {
      return finalize(input, "FAIL", execution.completed, failureHookError.value);
    }
    const completeHookError = yield* runHookError(input, "workflow.complete", failure);
    return finalize(input, "FAIL", execution.completed, Option.getOrUndefined(completeHookError) ?? failure);
  });

const finalizeWorkflowLifecycleEffect = (
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult,
): Effect.Effect<WorkflowLifecycleResult> => {
  if (execution.outcome === "CANCELLED") {
    return Effect.succeed(finalize(input, "CANCELLED", execution.completed, execution.failure));
  }

  if (execution.outcome === "FAIL") {
    return finalizeFailedWorkflow(input, execution);
  }

  return finalizePassedWorkflow(input, execution);
};

export const finalizeWorkflowLifecycle = async (
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult,
): Promise<WorkflowLifecycleResult> => await Effect.runPromise(finalizeWorkflowLifecycleEffect(input, execution));

const runWorkflowLifecycleEffect = (input: WorkflowLifecycleInput): Effect.Effect<WorkflowLifecycleResult, unknown> =>
  Effect.gen(function* effectBody() {
    const startFailure = yield* runWorkflowStartLifecycleEffect(input);
    if (Option.isSome(startFailure)) {
      return finalize(input, "FAIL", [], startFailure.value);
    }
    if (isWorkflowCancelled(input)) {
      return finalize(input, "CANCELLED", []);
    }
    const execution = yield* executeWorkflowEffect(input);
    return yield* finalizeWorkflowLifecycleEffect(input, execution);
  });

export const runWorkflowLifecycle = async (input: WorkflowLifecycleInput): Promise<WorkflowLifecycleResult> =>
  await Effect.runPromise(runWorkflowLifecycleEffect(input));
