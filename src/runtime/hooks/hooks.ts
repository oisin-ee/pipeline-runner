import {
  fromUndefinedOr,
  getOrUndefined,
  match,
  none,
  some,
} from "effect/Option";
import type { Option } from "effect/Option";

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
  | { failure: Option<RuntimeFailure>; type: "stop" }
  | { failure: Option<RuntimeFailure>; type: "continue" | "stop-cancelled" };

const hookDispatchResult = (failure: Option<RuntimeFailure>) =>
  getOrUndefined(failure) ?? null;

const recordHookFailure = (
  context: RuntimeContext,
  binding: Parameters<typeof runHookInvocation>[0]["binding"],
  failure: Option<RuntimeFailure>
): HookDispatchAction =>
  match(failure, {
    onNone: () => ({ failure: none(), type: "continue" }),
    onSome: (value) => {
      context.hookFailures.push(value);
      return binding.failure === "fail"
        ? { failure: some(value), type: "stop" }
        : { failure: none(), type: "continue" };
    },
  });

const isCancelled = (context: RuntimeContext): boolean =>
  context.signal?.aborted === true;

const dispatchHookBinding = async (
  context: RuntimeContext,
  event: HookEvent,
  binding: Parameters<typeof runHookInvocation>[0]["binding"],
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<HookDispatchAction> => {
  if (isCancelled(context)) {
    emitRuntimeHookSkipped(context, binding, "hook cancelled", node);
    return { failure: none(), type: "stop-cancelled" };
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
  return recordHookFailure(context, binding, fromUndefinedOr(result.failure));
};

export const dispatchHooks = async (
  context: RuntimeContext,
  event: HookEvent,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
) => {
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
      return hookDispatchResult(action.failure);
    }
    if (action.type === "stop") {
      return hookDispatchResult(action.failure);
    }
  }
  return hookDispatchResult(none());
};
