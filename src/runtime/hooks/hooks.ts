import type { HookEvent } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { RuntimeContext, RuntimeFailure } from "../contracts";
import {
  emitHookFinish,
  emitHookStart,
  emitRuntimeHookSkipped,
} from "./events";
import { runHookInvocation } from "./invocation";
import { hookBindingsForContext } from "./policy";
import { recordHookResult } from "./results";

type HookDispatchAction =
  | { failure: RuntimeFailure; type: "stop" }
  | { type: "continue" }
  | { type: "stop-cancelled" };

export async function dispatchHooks(
  context: RuntimeContext,
  event: HookEvent,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeFailure | null> {
  for (const binding of hookBindingsForContext(context, event, node, gateId)) {
    const action = await dispatchHookBinding(
      context,
      event,
      binding,
      failure,
      node,
      gateId
    );
    if (action.type === "stop-cancelled") {
      return null;
    }
    if (action.type === "stop") {
      return action.failure;
    }
  }
  return null;
}

async function dispatchHookBinding(
  context: RuntimeContext,
  event: HookEvent,
  binding: Parameters<typeof runHookInvocation>[0]["binding"],
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<HookDispatchAction> {
  if (isCancelled(context)) {
    emitRuntimeHookSkipped(context, binding, node, "hook cancelled");
    return { type: "stop-cancelled" };
  }
  const hookFunction = context.config.hooks.functions[binding.function];
  emitHookStart(context, event, binding, node, gateId);
  const result = await runHookInvocation({
    binding,
    context,
    event,
    failure,
    gateId,
    hookFunction,
    node,
  });
  emitHookFinish(context, event, binding, result.failure, node, gateId);
  if (result.hookResult) {
    recordHookResult(context, event, binding, result.hookResult, node, gateId);
  }
  return recordHookFailure(context, binding, result.failure);
}

function recordHookFailure(
  context: RuntimeContext,
  binding: Parameters<typeof runHookInvocation>[0]["binding"],
  failure?: RuntimeFailure
): HookDispatchAction {
  if (!failure) {
    return { type: "continue" };
  }
  context.hookFailures.push(failure);
  return binding.failure === "fail"
    ? { failure, type: "stop" }
    : { type: "continue" };
}

function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
}
