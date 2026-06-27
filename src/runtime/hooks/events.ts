import type { HookEvent } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { type RuntimeActorDescriptor, runtimeActorId } from "../actor-ids";
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

const runtimeHookResultEmitters: Record<
  HookInvocationResultEvent["status"],
  RuntimeHookResultEmitter
> = {
  failed: emitRuntimeHookFailedResult,
  passed: emitRuntimeHookFinished,
  skipped: emitRuntimeHookSkippedResult,
  timedOut: emitRuntimeHookTimedOutResult,
};

export function emitRuntimeHookStarted(
  context: RuntimeContext,
  binding: HookBinding,
  node?: PlannedWorkflowNode
): void {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    type: "runtime.hook.started",
  });
}

export function emitRuntimeHookResult(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  runtimeHookResultEmitters[result.status](context, binding, result, node);
}

export function emitRuntimeHookSkipped(
  context: RuntimeContext,
  binding: HookBinding,
  node: PlannedWorkflowNode | undefined,
  reason: string
): void {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    reason,
    type: "runtime.hook.skipped",
  });
}

export function emitHookStart(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  emit(context, hookStartEvent(context, event, binding, node, gateId));
}

export function emitHookFinish(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: RuntimeFailure | undefined,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  emit(context, hookFinishEvent(context, event, binding, result, node, gateId));
}

function hookStartEvent(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookStartEvent {
  return {
    event,
    functionId: binding.function,
    hookId: binding.id,
    required: binding.failure === "fail",
    type: "hook.start",
    workflowId: context.workflowId,
    ...hookEventNode(node),
    ...hookEventGate(gateId),
  };
}

function hookFinishEvent(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: RuntimeFailure | undefined,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookFinishEvent {
  return {
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
  };
}

function emitRuntimeHookFinished(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    passed: result.status === "passed",
    reason: hookResultReason(result),
    type: "runtime.hook.finished",
  });
}

function emitRuntimeHookFailedResult(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  emitRuntimeHookFinished(context, binding, result, node);
  emitRuntimeHookFailed(context, binding, result, node);
}

function emitRuntimeHookTimedOutResult(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  emitRuntimeHookFinished(context, binding, result, node);
  emitRuntimeHookTimedOut(context, binding, result, node);
}

function emitRuntimeHookSkippedResult(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  emitRuntimeHookSkipped(
    context,
    binding,
    node,
    hookRequiredReason(result, "hook skipped")
  );
}

function emitRuntimeHookFailed(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    reason: hookRequiredReason(result, "hook failed"),
    type: "runtime.hook.failed",
  });
}

function emitRuntimeHookTimedOut(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookInvocationResultEvent,
  node?: PlannedWorkflowNode
): void {
  context.observability?.({
    ...hookObservabilityBase(context, binding, node),
    reason: hookRequiredReason(result, "hook timed out"),
    type: "runtime.hook.timedOut",
  });
}

function hookObservabilityBase(
  context: RuntimeContext,
  binding: HookBinding,
  node?: PlannedWorkflowNode
): HookObservabilityBase {
  return {
    actor: runtimeHookActor(context, binding.id, node?.id),
    hookId: binding.id,
    nodeId: node?.id,
    timestamp: runtimeTimestamp(),
  };
}

function hookResultReason(
  result: HookInvocationResultEvent
): string | undefined {
  return result.reason ?? result.failure?.reason;
}

function hookRequiredReason(
  result: HookInvocationResultEvent,
  fallback: string
): string {
  return hookResultReason(result) ?? fallback;
}

function hookEventNode(
  node?: PlannedWorkflowNode
): Pick<HookStartEvent, "nodeId"> | EmptyObject {
  return node ? { nodeId: node.id } : {};
}

function hookEventGate(
  gateId?: string
): Pick<HookStartEvent, "gateId"> | EmptyObject {
  return gateId ? { gateId } : {};
}

function hookEventFailureReason(
  result?: RuntimeFailure
): Pick<HookFinishEvent, "reason"> | EmptyObject {
  return result?.reason ? { reason: result.reason } : {};
}

function runtimeHookActor(
  context: RuntimeContext,
  hookId: string,
  nodeId?: string
): RuntimeActorDescriptor {
  return {
    id: runtimeActorId("hook", {
      hookId,
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    kind: "hook",
    systemId: runtimeSystemId(context),
  };
}

function runtimeTimestamp(): string {
  return new Date().toISOString();
}
