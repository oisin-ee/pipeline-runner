import type { PlannedWorkflowNode } from "../../planning/compile";
import type { HookBinding, RuntimeFailure } from "../contracts";
import { emitRuntimeHookResult, emitRuntimeHookStarted } from "./events";
import { executeHookFunction } from "./execution";
import type {
  HookExecutionInput,
  HookInvocationResultEvent,
  RuntimeHookInvocationResult,
} from "./types";

export async function runHookInvocation(
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> {
  let invocationResult: RuntimeHookInvocationResult = {};
  emitRuntimeHookStarted(input.context, input.binding, input.node);
  const resultEvent = await resolveHookInvocationResult(
    () => executeHookFunction(input),
    input.binding,
    input.node,
    (result) => {
      invocationResult = result;
    }
  );
  emitRuntimeHookResult(input.context, input.binding, resultEvent, input.node);
  return resultEvent.failure
    ? { ...invocationResult, failure: resultEvent.failure }
    : invocationResult;
}

async function resolveHookInvocationResult(
  execute: () =>
    | Promise<RuntimeHookInvocationResult>
    | RuntimeHookInvocationResult,
  binding: HookBinding,
  node: PlannedWorkflowNode | undefined,
  setInvocationResult: (result: RuntimeHookInvocationResult) => void
): Promise<HookInvocationResultEvent> {
  try {
    const invocationResult = await execute();
    setInvocationResult(invocationResult);
    return invocationResultEvent(invocationResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
}

function invocationResultEvent(
  result: RuntimeHookInvocationResult
): HookInvocationResultEvent {
  return result.failure ? failedHookEvent(result.failure) : passedHookEvent();
}

function failedHookEvent(failure: RuntimeFailure): HookInvocationResultEvent {
  return {
    failure,
    reason: failure.reason,
    status: "failed",
  };
}

function passedHookEvent(): HookInvocationResultEvent {
  return { status: "passed" };
}
