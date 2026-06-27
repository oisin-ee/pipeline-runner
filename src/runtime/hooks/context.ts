import type { HookEvent } from "../../config";
import type { HookContext } from "../../hooks";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  HookBinding,
  PipelineTaskContext,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";

type EmptyObject = Record<string, never>;

export function hookContext(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookContext {
  const taskContext = node
    ? effectiveTaskContext(node, context)
    : context.taskContext;
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
}

function hookEventContext(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookContext["event"] {
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
}

function failureContext(
  failure?: RuntimeFailure
): Pick<HookContext, "failure"> | EmptyObject {
  return failure ? { failure } : {};
}

function nodeContext(
  node?: PlannedWorkflowNode
): Pick<HookContext, "node"> | EmptyObject {
  return node ? { node: { id: node.id } } : {};
}

function taskContextField(
  taskContext?: PipelineTaskContext
): Pick<HookContext, "taskContext"> | EmptyObject {
  return taskContext ? { taskContext } : {};
}

function effectiveTaskContext(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): PipelineTaskContext | undefined {
  return node.taskContext ?? context.taskContext;
}
