import type { PlannedWorkflowNode } from "../../planning/compile";
import type { HookBinding, RuntimeFailure } from "../contracts";
import { emitRuntimeHookResult, emitRuntimeHookStarted } from "./events";
import { executeHookFunction } from "./execution";
import type {
  HookExecutionInput,
  HookInvocationResultEvent,
  RuntimeHookInvocationResult,
} from "./types";

const failedHookEvent = (
  failure: RuntimeFailure
): HookInvocationResultEvent => ({
  failure,
  reason: failure.reason,
  status: "failed",
});

const passedHookEvent = (): HookInvocationResultEvent => ({ status: "passed" });

const invocationResultEvent = (
  result: RuntimeHookInvocationResult
): HookInvocationResultEvent =>
  result.failure ? failedHookEvent(result.failure) : passedHookEvent();

const resolveHookInvocationResult = async (
  execute: () =>
    | Promise<RuntimeHookInvocationResult>
    | RuntimeHookInvocationResult,
  binding: HookBinding,
  setInvocationResult: (result: RuntimeHookInvocationResult) => void,
  node?: PlannedWorkflowNode
): Promise<HookInvocationResultEvent> => {
  try {
    const invocationResult = await execute();
    setInvocationResult(invocationResult);
    return invocationResultEvent(invocationResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: {
        evidence: [message],
        gate: binding.id,
        nodeId: node?.id,
        reason: `hook '${binding.id}' failed`,
      },
      reason: message,
      status: "failed",
    };
  }
};

export const runHookInvocation = async (
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> => {
  let invocationResult: RuntimeHookInvocationResult = {};
  emitRuntimeHookStarted(input.context, input.binding, input.node);
  const resultEvent = await resolveHookInvocationResult(
    async () => await executeHookFunction(input),
    input.binding,
    (result) => {
      invocationResult = result;
    },
    input.node
  );
  emitRuntimeHookResult(input.context, input.binding, resultEvent, input.node);
  return resultEvent.failure
    ? { ...invocationResult, failure: resultEvent.failure }
    : invocationResult;
};
