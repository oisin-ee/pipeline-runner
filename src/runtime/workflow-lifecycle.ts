import { Effect } from "effect";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeNodeResult,
} from "./contracts";

export type WorkflowHookEvent =
  | "workflow.complete"
  | "workflow.failure"
  | "workflow.start"
  | "workflow.success";

export interface WorkflowExecutionResult {
  completed: RuntimeNodeResult[];
  failure?: RuntimeFailure;
  outcome: PipelineRuntimeResult["outcome"];
}

export interface WorkflowLifecycleInput {
  buildResult: (
    outcome: PipelineRuntimeResult["outcome"],
    nodes: RuntimeNodeResult[],
    failure?: RuntimeFailure
  ) => PipelineRuntimeResult;
  emitWorkflowPlanned: () => void;
  emitWorkflowStarted: () => void;
  executeWorkflow: () => Promise<WorkflowExecutionResult>;
  isCancelled?: () => boolean;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure?: RuntimeFailure
  ) => Promise<RuntimeFailure | null> | RuntimeFailure | null;
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

export type WorkflowFinalizationInput = Pick<
  WorkflowLifecycleInput,
  "buildResult" | "isCancelled" | "runWorkflowHook"
>;

export function runWorkflowLifecycle(
  input: WorkflowLifecycleInput
): Promise<WorkflowLifecycleResult> {
  return Effect.runPromise(runWorkflowLifecycleEffect(input));
}

export function runWorkflowStartLifecycle(
  input: WorkflowStartLifecycleInput
): Promise<RuntimeFailure | undefined> {
  return Effect.runPromise(runWorkflowStartLifecycleEffect(input));
}

export function finalizeWorkflowLifecycle(
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult
): Promise<WorkflowLifecycleResult> {
  return Effect.runPromise(finalizeWorkflowLifecycleEffect(input, execution));
}

function runWorkflowLifecycleEffect(
  input: WorkflowLifecycleInput
): Effect.Effect<WorkflowLifecycleResult, unknown> {
  return Effect.gen(function* () {
    const startFailure = yield* runWorkflowStartLifecycleEffect(input);
    if (startFailure) {
      return finalize(input, "FAIL", [], startFailure);
    }
    if (isWorkflowCancelled(input)) {
      return finalize(input, "CANCELLED", []);
    }
    const execution = yield* executeWorkflowEffect(input);
    return yield* finalizeWorkflowLifecycleEffect(input, execution);
  });
}

function runWorkflowStartLifecycleEffect(
  input: WorkflowStartLifecycleInput
): Effect.Effect<RuntimeFailure | undefined, unknown> {
  return Effect.gen(function* () {
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
}

function finalizeWorkflowLifecycleEffect(
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult
): Effect.Effect<WorkflowLifecycleResult> {
  if (execution.outcome === "CANCELLED") {
    return Effect.succeed(
      finalize(input, "CANCELLED", execution.completed, execution.failure)
    );
  }

  if (execution.outcome === "FAIL") {
    return finalizeFailedWorkflow(input, execution);
  }

  return finalizePassedWorkflow(input, execution);
}

function finalizeFailedWorkflow(
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult
): Effect.Effect<WorkflowLifecycleResult> {
  return Effect.gen(function* () {
    const failure = execution.failure ?? workflowFailure();
    const failureHookError = yield* runHookError(
      input,
      "workflow.failure",
      failure
    );
    if (failureHookError) {
      return finalize(input, "FAIL", execution.completed, failureHookError);
    }
    const completeHookError = yield* runHookError(
      input,
      "workflow.complete",
      failure
    );
    return finalize(
      input,
      "FAIL",
      execution.completed,
      completeHookError ?? failure
    );
  });
}

function finalizePassedWorkflow(
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult
): Effect.Effect<WorkflowLifecycleResult> {
  return Effect.gen(function* () {
    const successHookFailure = yield* runHook(input, "workflow.success");
    const completeFailure = yield* runHook(
      input,
      "workflow.complete",
      successHookFailure
    );
    const hookFailure = completeFailure ?? successHookFailure;
    if (hookFailure) {
      return hookFailureResult(
        input,
        execution.completed,
        hookFailure,
        successHookFailure
      );
    }
    if (isWorkflowCancelled(input)) {
      return finalize(input, "CANCELLED", execution.completed);
    }
    return finalize(input, "PASS", execution.completed);
  });
}

function runHook(
  input: Pick<WorkflowLifecycleInput, "runWorkflowHook">,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure
): Effect.Effect<RuntimeFailure | undefined> {
  return runHookEffect(input, event, failure).pipe(
    Effect.map((result) => result ?? undefined),
    Effect.catchAll((error) => Effect.succeed(hookRuntimeFailure(error)))
  );
}

function runHookError(
  input: WorkflowFinalizationInput,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure
): Effect.Effect<RuntimeFailure | undefined> {
  return runHookEffect(input, event, failure).pipe(
    Effect.as(undefined),
    Effect.catchAll((error) => Effect.succeed(hookRuntimeFailure(error)))
  );
}

function runHookEffect(
  input: Pick<WorkflowLifecycleInput, "runWorkflowHook">,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure
): Effect.Effect<RuntimeFailure | null, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: async () => await input.runWorkflowHook(event, failure),
  });
}

function executeWorkflowEffect(
  input: Pick<WorkflowLifecycleInput, "executeWorkflow">
): Effect.Effect<WorkflowExecutionResult, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => input.executeWorkflow(),
  });
}

function finalize(
  input: WorkflowFinalizationInput,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure
): WorkflowLifecycleResult {
  const status = workflowLifecycleStatus(outcome);
  return {
    ...(failure ? { failure } : {}),
    result: input.buildResult(outcome, nodes, failure),
    status,
  };
}

function workflowLifecycleStatus(
  outcome: PipelineRuntimeResult["outcome"]
): WorkflowLifecycleResult["status"] {
  if (outcome === "CANCELLED") {
    return "cancelled";
  }
  if (outcome === "FAIL") {
    return "failed";
  }
  return "passed";
}

function hookFailureResult(
  input: WorkflowFinalizationInput,
  nodes: RuntimeNodeResult[],
  hookFailure: RuntimeFailure,
  successHookFailure: RuntimeFailure | undefined
): WorkflowLifecycleResult {
  return {
    ...(successHookFailure ? { successHookFailure } : {}),
    failure: hookFailure,
    result: input.buildResult("FAIL", nodes, hookFailure),
    status: "failed",
  };
}

function isWorkflowCancelled(input: WorkflowFinalizationInput): boolean {
  return input.isCancelled?.() ?? false;
}

function hookRuntimeFailure(error: unknown): RuntimeFailure {
  const reason = error instanceof Error ? error.message : String(error);
  return { evidence: [reason], gate: "workflow.hook", reason };
}

function workflowFailure(): RuntimeFailure {
  return {
    evidence: ["workflow failed without a specific failure"],
    gate: "workflow",
    reason: "workflow failed",
  };
}
