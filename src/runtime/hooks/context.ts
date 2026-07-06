import { fromUndefinedOr, match, orElse } from "effect/Option";
import type { Option } from "effect/Option";

import type { HookEvent } from "../../config";
import type { HookContext } from "../../hooks";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { HookBinding, PipelineTaskContext, RuntimeContext, RuntimeFailure } from "../contracts";

type EmptyObject = Record<string, never>;

const hookEventContext = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string,
): HookContext["event"] => {
  const output: HookContext["event"] = {
    hookId: binding.id,
    type: event,
    workflowId: context.workflowId,
  };
  if (gateId !== undefined) {
    output.gateId = gateId;
  }
  if (node !== undefined) {
    output.nodeId = node.id;
  }
  return output;
};

const failureContext = (failure?: RuntimeFailure): Pick<HookContext, "failure"> | EmptyObject =>
  failure ? { failure } : {};

const nodeContext = (node?: PlannedWorkflowNode): Pick<HookContext, "node"> | EmptyObject =>
  node ? { node: { id: node.id } } : {};

const taskContextField = (taskContext: Option<PipelineTaskContext>): Pick<HookContext, "taskContext"> | EmptyObject =>
  match(taskContext, {
    onNone: () => ({}),
    onSome: (value) => ({ taskContext: value }),
  });

const effectiveTaskContext = (node: PlannedWorkflowNode, context: RuntimeContext): Option<PipelineTaskContext> =>
  orElse(fromUndefinedOr(node.taskContext), () => fromUndefinedOr(context.taskContext));

export const hookContext = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string,
): HookContext => {
  const taskContext = node ? effectiveTaskContext(node, context) : fromUndefinedOr(context.taskContext);
  return {
    event: hookEventContext(context, event, binding, node, gateId),
    input: binding.with ?? {},
    results: Object.fromEntries(context.hookResults),
    task: context.task,
    workflow: { id: context.workflowId },
    ...failureContext(failure),
    ...nodeContext(node),
    ...taskContextField(taskContext),
  };
};
