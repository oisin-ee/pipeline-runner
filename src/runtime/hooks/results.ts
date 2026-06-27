import type { HookEvent } from "../../config";
import { type HookResult, parseHookResult } from "../../hooks";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  HookBinding,
  HookFunctionSpec,
  PipelineRuntimeEvent,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { emit } from "../events";
import { validateJsonSchemaSource } from "../json-validation";
import type { RuntimeHookInvocationResult } from "./types";

type EmptyObject = Record<string, never>;
type HookResultRuntimeEvent = Extract<
  PipelineRuntimeEvent,
  { type: "hook.result" }
>;

export function runtimeHookFailure(
  binding: HookBinding,
  reason: string,
  evidence: string[],
  node?: PlannedWorkflowNode
): RuntimeFailure {
  return {
    evidence,
    gate: binding.id,
    nodeId: node?.id,
    reason,
  };
}

export function recordHookResult(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  saveHookResult(context, binding, result);
  publishHookResult(context, event, binding, result, node, gateId);
}

function saveHookResult(
  context: RuntimeContext,
  binding: HookBinding,
  result: HookResult
): void {
  if (binding.result?.save_as) {
    context.hookResults.set(binding.result.save_as, result);
  }
}

function publishHookResult(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  if (binding.result?.publish === true) {
    emit(
      context,
      hookResultEvent(context, event, binding, result, node, gateId)
    );
  }
}

function hookResultEvent(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookResultRuntimeEvent {
  return {
    event,
    functionId: binding.function,
    hookId: binding.id,
    status: result.status,
    type: "hook.result",
    workflowId: context.workflowId,
    ...hookResultArtifacts(result),
    ...hookResultGate(gateId),
    ...hookResultNode(node),
    ...hookResultOutputs(result),
    ...hookResultSummary(result),
  };
}

function hookResultArtifacts(
  result: HookResult
): Pick<HookResultRuntimeEvent, "artifacts"> | EmptyObject {
  return result.artifacts ? { artifacts: result.artifacts } : {};
}

function hookResultGate(
  gateId?: string
): Pick<HookResultRuntimeEvent, "gateId"> | EmptyObject {
  return gateId ? { gateId } : {};
}

function hookResultNode(
  node?: PlannedWorkflowNode
): Pick<HookResultRuntimeEvent, "nodeId"> | EmptyObject {
  return node ? { nodeId: node.id } : {};
}

function hookResultOutputs(
  result: HookResult
): Pick<HookResultRuntimeEvent, "outputs"> | EmptyObject {
  return result.outputs ? { outputs: result.outputs } : {};
}

function hookResultSummary(
  result: HookResult
): Pick<HookResultRuntimeEvent, "summary"> | EmptyObject {
  return result.summary ? { summary: result.summary } : {};
}

export function parseAndValidateHookResult(
  value: unknown,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeHookInvocationResult {
  try {
    return validatedHookResult(
      parseHookResult(value),
      binding,
      hookFunction,
      context,
      node
    );
  } catch (err) {
    return {
      failure: runtimeHookFailure(
        binding,
        "hook result validation failed",
        [err instanceof Error ? err.message : String(err)],
        node
      ),
    };
  }
}

function validatedHookResult(
  result: HookResult,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeHookInvocationResult {
  const schemaFailure = hookResultSchemaFailure(
    result,
    binding,
    hookFunction,
    context,
    node
  );
  return {
    failure: schemaFailure ?? hookResultFailure(binding, result, node),
    hookResult: result,
  };
}

function hookResultSchemaFailure(
  result: HookResult,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeFailure | undefined {
  const schema = hookFunction.returns?.schema;
  return schema
    ? validateHookResultAgainstSchema(result, binding, schema, context, node)
    : undefined;
}

function validateHookResultAgainstSchema(
  result: HookResult,
  binding: HookBinding,
  schema: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeFailure | undefined {
  const validation = validateJsonSchemaSource(
    JSON.stringify(result),
    schema,
    context.worktreePath
  );
  return validation.passed
    ? undefined
    : runtimeHookFailure(
        binding,
        validation.reason ?? "hook result schema validation failed",
        validation.evidence,
        node
      );
}

function hookResultFailure(
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode
): RuntimeFailure | undefined {
  if (result.status !== "fail") {
    return;
  }
  return runtimeHookFailure(
    binding,
    result.summary ?? `hook '${binding.id}' failed`,
    [result.summary ?? `hook '${binding.id}' returned fail`],
    node
  );
}
