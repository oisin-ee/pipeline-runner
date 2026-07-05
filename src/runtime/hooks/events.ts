import { fromUndefinedOr, getOrUndefined, match, orElse } from "effect/Option";
import type { Option } from "effect/Option";

import type { HookEvent } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { runtimeActorId } from "../actor-ids";
import type { RuntimeActorDescriptor } from "../actor-ids";
import type {
  HookBinding,
  PipelineRuntimeEvent,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { emit, runtimeSystemId } from "../events";
import type { HookInvocationResultEvent } from "./types";

type EmptyObject = Record<string, never>;
type HookStartEvent = Extract<PipelineRuntimeEvent, { type: "hook.start" }>;
type HookFinishEvent = Extract<PipelineRuntimeEvent, { type: "hook.finish" }>;
interface HookObservabilityBase {
  actor: RuntimeActorDescriptor;
  hookId: string;
  nodeId?: string;
  timestamp: string;
}
type RuntimeHookResultEmitter = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
) => void;

const hookResultReason = (result: HookInvocationResultEvent): Option<string> =>
  orElse(fromUndefinedOr(result.reason), () =>
    fromUndefinedOr(result.failure?.reason)
  );

const hookRequiredReason = (
  result: HookInvocationResultEvent,
  fallback: string
): string => getOrUndefined(hookResultReason(result)) ?? fallback;

const hookEventNode = (
  node?: PlannedWorkflowNode
): Pick<HookStartEvent, "nodeId"> | EmptyObject =>
  node ? { nodeId: node.id } : {};

const hookEventGate = (
  gateId?: string
): Pick<HookStartEvent, "gateId"> | EmptyObject =>
  gateId === undefined || gateId.length === 0 ? {} : { gateId };

const hookStartEvent = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookStartEvent => ({
  event,
  functionId: binding.function,
  hookId: binding.id,
  required: binding.failure === "fail",
  type: "hook.start",
  workflowId: context.workflowId,
  ...hookEventNode(node),
  ...hookEventGate(gateId),
});

export const emitHookStart = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string
): void => {
  emit(context, hookStartEvent(context, event, binding, node, gateId));
};

const hookEventFailureReason = (
  result?: RuntimeFailure
): Pick<HookFinishEvent, "reason"> | EmptyObject =>
  match(fromUndefinedOr(result?.reason), {
    onNone: () => ({}),
    onSome: (reason) => ({ reason }),
  });

const hookFinishEvent = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookFinishEvent => ({
  event,
  functionId: binding.function,
  hookId: binding.id,
  passed: result === undefined,
  required: binding.failure === "fail",
  type: "hook.finish",
  workflowId: context.workflowId,
  ...hookEventNode(node),
  ...hookEventGate(gateId),
  ...hookEventFailureReason(result),
});

export const emitHookFinish = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): void => {
  emit(context, hookFinishEvent(context, event, binding, result, node, gateId));
};

const runtimeHookActor = (
  context: RuntimeContext,
  hookId: string,
  nodeId?: string
): RuntimeActorDescriptor => ({
  id: runtimeActorId("hook", {
    hookId,
    nodeId,
    runId: context.runId,
    workflowId: context.workflowId,
  }),
  kind: "hook",
  systemId: runtimeSystemId(context),
});

const runtimeTimestamp = (): string => new Date().toISOString();

const hookObservabilityBase = (
  context: RuntimeContext,
  binding: HookBinding,
  node?: PlannedWorkflowNode
): HookObservabilityBase => ({
  actor: runtimeHookActor(context, binding.id, node?.id),
  hookId: binding.id,
  nodeId: node?.id,
  timestamp: runtimeTimestamp(),
});

export const emitRuntimeHookStarted = (
  context: RuntimeContext,
  binding: HookBinding,
  node?: PlannedWorkflowNode
): void => {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    type: "runtime.hook.started",
  });
};

export const emitRuntimeHookSkipped = (
  context: RuntimeContext,
  binding: HookBinding,
  reason: string,
  node?: PlannedWorkflowNode
): void => {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    reason,
    type: "runtime.hook.skipped",
  });
};

const emitRuntimeHookSkippedResult = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  emitRuntimeHookSkipped(
    context,
    binding,
    hookRequiredReason(result, "hook skipped"),
    node
  );
};

const emitRuntimeHookFinished = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    passed: result.status === "passed",
    reason: getOrUndefined(hookResultReason(result)),
    type: "runtime.hook.finished",
  });
};

const emitRuntimeHookFailed = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    reason: hookRequiredReason(result, "hook failed"),
    type: "runtime.hook.failed",
  });
};

const emitRuntimeHookFailedResult = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  emitRuntimeHookFinished(context, binding, result, node);
  emitRuntimeHookFailed(context, binding, result, node);
};

const emitRuntimeHookTimedOut = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    reason: hookRequiredReason(result, "hook timed out"),
    type: "runtime.hook.timedOut",
  });
};

const emitRuntimeHookTimedOutResult = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  emitRuntimeHookFinished(context, binding, result, node);
  emitRuntimeHookTimedOut(context, binding, result, node);
};

const runtimeHookResultEmitters: Record<
  HookInvocationResultEvent["status"],
  RuntimeHookResultEmitter
> = {
  failed: emitRuntimeHookFailedResult,
  passed: emitRuntimeHookFinished,
  skipped: emitRuntimeHookSkippedResult,
  timedOut: emitRuntimeHookTimedOutResult,
};

export const emitRuntimeHookResult = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void => {
  runtimeHookResultEmitters[result.status](context, binding, result, node);
};
