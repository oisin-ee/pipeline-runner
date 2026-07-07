import { Option } from "effect";

import type { HookEvent } from "../../config";
import { parseHookResult } from "../../hooks";
import type { HookResult } from "../../hooks";
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

export const runtimeHookFailure = (
  binding: HookBinding,
  reason: string,
  evidence: string[],
  node?: PlannedWorkflowNode
): RuntimeFailure => ({
  evidence,
  gate: binding.id,
  nodeId: node?.id,
  reason,
});

const saveHookResult = (
  context: RuntimeContext,
  binding: HookBinding,
  result: HookResult
): void => {
  const saveAs = binding.result?.save_as;
  if (saveAs !== undefined && saveAs.length > 0) {
    context.hookResults.set(saveAs, result);
  }
};

const hookResultArtifacts = (
  result: HookResult
): Pick<HookResultRuntimeEvent, "artifacts"> | EmptyObject =>
  result.artifacts ? { artifacts: result.artifacts } : {};

const hookResultGate = (
  gateId?: string
): Pick<HookResultRuntimeEvent, "gateId"> | EmptyObject =>
  gateId === undefined || gateId.length === 0 ? {} : { gateId };

const hookResultNode = (
  node?: PlannedWorkflowNode
): Pick<HookResultRuntimeEvent, "nodeId"> | EmptyObject =>
  node ? { nodeId: node.id } : {};

const hookResultOutputs = (
  result: HookResult
): Pick<HookResultRuntimeEvent, "outputs"> | EmptyObject =>
  result.outputs ? { outputs: result.outputs } : {};

const hookResultSummary = (
  result: HookResult
): Pick<HookResultRuntimeEvent, "summary"> | EmptyObject =>
  result.summary === undefined || result.summary.length === 0
    ? {}
    : { summary: result.summary };

const hookResultEvent = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookResultRuntimeEvent => ({
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
});

const publishHookResult = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): void => {
  if (binding.result?.publish === true) {
    emit(
      context,
      hookResultEvent(context, event, binding, result, node, gateId)
    );
  }
};

export const recordHookResult = (
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): void => {
  saveHookResult(context, binding, result);
  publishHookResult(context, event, binding, result, node, gateId);
};

const validateHookResultAgainstSchema = (
  result: HookResult,
  binding: HookBinding,
  schema: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Option.Option<RuntimeFailure> => {
  const validation = validateJsonSchemaSource(
    JSON.stringify(result),
    schema,
    context.worktreePath
  );
  return validation.passed
    ? Option.none()
    : Option.some(
        runtimeHookFailure(
          binding,
          validation.reason ?? "hook result schema validation failed",
          validation.evidence,
          node
        )
      );
};

const hookResultSchemaFailure = (
  result: HookResult,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Option.Option<RuntimeFailure> => {
  const schema = hookFunction.returns?.schema;
  return schema === undefined || schema.length === 0
    ? Option.none()
    : validateHookResultAgainstSchema(result, binding, schema, context, node);
};

const hookResultFailure = (
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode
): Option.Option<RuntimeFailure> => {
  if (result.status !== "fail") {
    return Option.none();
  }
  return Option.some(
    runtimeHookFailure(
      binding,
      result.summary ?? `hook '${binding.id}' failed`,
      [result.summary ?? `hook '${binding.id}' returned fail`],
      node
    )
  );
};

const validatedHookResult = (
  result: HookResult,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeHookInvocationResult => {
  const schemaFailure = hookResultSchemaFailure(
    result,
    binding,
    hookFunction,
    context,
    node
  );
  const failure = Option.orElse(schemaFailure, () =>
    hookResultFailure(binding, result, node)
  );
  return {
    failure: Option.getOrUndefined(failure),
    hookResult: result,
  };
};

export const parseAndValidateHookResult = (
  value: unknown,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeHookInvocationResult => {
  try {
    return validatedHookResult(
      parseHookResult(value),
      binding,
      hookFunction,
      context,
      node
    );
  } catch (error) {
    return {
      failure: runtimeHookFailure(
        binding,
        "hook result validation failed",
        [error instanceof Error ? error.message : String(error)],
        node
      ),
    };
  }
};
