// fallow-ignore-file code-duplication
import { randomUUID } from "node:crypto";

import * as Option from "effect/Option";

import { loadPipelineConfig } from "../../config";
import type { PipelineConfig } from "../../config";
import { compileWorkflowPlan } from "../../planning/compile";
import type { PlannedWorkflowNode, WorkflowExecutionPlan } from "../../planning/compile";
import { runLaunchPlan } from "../../runner/subprocess";
import type { PipelineRuntimeOptions, RuntimeContext } from "../contracts";
import { createPublicRuntimeObservabilityEmitter } from "../events";
import { initialNodeStateStore } from "../node-state-store";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_OUTPUT_LIMIT_BYTES = 64 * 1024;

const resolveWorkflowSelectionOption = (config: PipelineConfig, workflowId?: string, entrypointId?: string) => {
  if (workflowId !== undefined && workflowId.length > 0) {
    return Option.some(workflowId);
  }
  if (entrypointId === undefined || entrypointId.length === 0) {
    return Option.none<string>();
  }
  if (!Object.hasOwn(config.entrypoints, entrypointId)) {
    throw new Error(`Unknown pipeline entrypoint '${entrypointId}'`);
  }
  const entrypoint = config.entrypoints[entrypointId];
  if ("schedule" in entrypoint) {
    throw new Error(
      `Pipeline entrypoint '${entrypointId}' generates schedule '${entrypoint.schedule}'; run with --schedule <schedule.yaml> instead.`,
    );
  }
  return Option.some(entrypoint.workflow);
};

export const resolveWorkflowSelection = (config: PipelineConfig, workflowId?: string, entrypointId?: string) =>
  Option.getOrUndefined(resolveWorkflowSelectionOption(config, workflowId, entrypointId));

const normalizeMaxParallelNodes = (value: number): number => {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error("maxParallelNodes must be a positive integer");
  }
  return value;
};

const runtimeMaxParallelNodes = (
  options: PipelineRuntimeOptions,
  plan: WorkflowExecutionPlan,
): Option.Option<number> => {
  if (options.maxParallelNodes !== undefined) {
    return Option.some(normalizeMaxParallelNodes(options.maxParallelNodes));
  }
  if (plan.execution.maxParallelNodes !== undefined) {
    return Option.some(normalizeMaxParallelNodes(plan.execution.maxParallelNodes));
  }
  return Option.none();
};

const nodesReferenceRunIdTemplate = (nodes: PlannedWorkflowNode[]): boolean =>
  nodes.some((node) => nodesReferenceRunIdTemplate(node.children ?? []));

const planReferencesRunIdTemplate = (plan: WorkflowExecutionPlan): boolean =>
  nodesReferenceRunIdTemplate(plan.topologicalOrder);

export const generateRuntimeRunId = (): string => `run-${randomUUID()}`;

export const createRuntimeContext = (options: PipelineRuntimeOptions): RuntimeContext => {
  const worktreePath = options.worktreePath ?? process.cwd();
  const config = options.config ?? loadPipelineConfig(worktreePath);
  const workflowSelection = resolveWorkflowSelection(config, options.workflowId, options.entrypoint);
  const plan = compileWorkflowPlan(config, workflowSelection);
  const { workflowId } = plan;
  const runId = options.runId ?? (planReferencesRunIdTemplate(plan) ? generateRuntimeRunId() : undefined);
  const observability =
    options.reporter === undefined ? undefined : createPublicRuntimeObservabilityEmitter(options.reporter, workflowId);
  const maxParallelNodes = runtimeMaxParallelNodes(options, plan);
  return {
    agentInvocations: [],
    ...(options.availableModels === undefined ? {} : { availableModels: options.availableModels }),
    ...(runId === undefined || runId.length === 0 ? {} : { runId }),
    config,
    executor: options.executor ?? runLaunchPlan,
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: options.hookPolicy?.allowCommandHooks ?? true,
      allowUntrustedCommandHooks: options.hookPolicy?.allowUntrustedCommandHooks ?? true,
      env: options.hookPolicy?.env ?? {},
      envPassthrough: options.hookPolicy?.envPassthrough ?? ["PATH"],
      outputLimitBytes: options.hookPolicy?.outputLimitBytes ?? DEFAULT_HOOK_OUTPUT_LIMIT_BYTES,
      timeoutMs: options.hookPolicy?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    hookResults: new Map(),
    maxParallelNodes: Option.getOrUndefined(maxParallelNodes),
    nodeStateStore: initialNodeStateStore(plan),
    ...(observability === undefined ? {} : { observability }),
    plan,
    ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    task: options.task,
    ...(options.taskContext === undefined ? {} : { taskContext: options.taskContext }),
    workflowId,
    worktreePath,
  };
};
