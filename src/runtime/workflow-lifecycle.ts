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

export async function runWorkflowLifecycle(
  input: WorkflowLifecycleInput
): Promise<WorkflowLifecycleResult> {
  const startFailure = await runWorkflowStartLifecycle(input);
  if (startFailure) {
    return finalize(input, "FAIL", [], startFailure);
  }
  if (input.isCancelled?.()) {
    return finalize(input, "CANCELLED", []);
  }

  const execution = await input.executeWorkflow();
  return finalizeWorkflowLifecycle(input, execution);
}

export function runWorkflowStartLifecycle(
  input: WorkflowStartLifecycleInput
): Promise<RuntimeFailure | undefined> {
  input.emitWorkflowPlanned();
  input.emitWorkflowStarted();
  return runHook(input, "workflow.start");
}

export async function finalizeWorkflowLifecycle(
  input: WorkflowFinalizationInput,
  execution: WorkflowExecutionResult
): Promise<WorkflowLifecycleResult> {
  if (execution.outcome === "CANCELLED") {
    return finalize(input, "CANCELLED", execution.completed, execution.failure);
  }

  if (execution.outcome === "FAIL") {
    const failure = execution.failure ?? workflowFailure();
    const failureHookError = await runHookError(
      input,
      "workflow.failure",
      failure
    );
    if (failureHookError) {
      return finalize(input, "FAIL", execution.completed, failureHookError);
    }
    const completeHookError = await runHookError(
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
  }

  const successHookFailure = await runHook(input, "workflow.success");
  const completeFailure = await runHook(
    input,
    "workflow.complete",
    successHookFailure ?? undefined
  );
  const hookFailure = completeFailure ?? successHookFailure ?? undefined;
  if (hookFailure) {
    return {
      ...(successHookFailure ? { successHookFailure } : {}),
      ...(hookFailure ? { failure: hookFailure } : {}),
      result: input.buildResult("FAIL", execution.completed, hookFailure),
      status: "failed",
    };
  }
  if (input.isCancelled?.()) {
    return finalize(input, "CANCELLED", execution.completed);
  }

  return finalize(input, "PASS", execution.completed);
}

async function runHook(
  input: Pick<WorkflowLifecycleInput, "runWorkflowHook">,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure
): Promise<RuntimeFailure | undefined> {
  try {
    return (await input.runWorkflowHook(event, failure)) ?? undefined;
  } catch (error: unknown) {
    return hookRuntimeFailure(error);
  }
}

async function runHookError(
  input: WorkflowFinalizationInput,
  event: WorkflowHookEvent,
  failure?: RuntimeFailure
): Promise<RuntimeFailure | undefined> {
  try {
    await input.runWorkflowHook(event, failure);
    return;
  } catch (error: unknown) {
    return hookRuntimeFailure(error);
  }
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
