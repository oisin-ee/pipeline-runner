import { randomUUID } from "node:crypto";
import { loadPipelineConfig, type PipelineConfig } from "../../config";
import {
  compileWorkflowPlan,
  type PlannedWorkflowNode,
  type WorkflowExecutionPlan,
} from "../../planning/compile";
import { runLaunchPlan } from "../../runner";
import type { PipelineRuntimeOptions, RuntimeContext } from "../contracts";
import { createPublicRuntimeObservabilityEmitter } from "../events";
import { initialNodeStateStore } from "../node-state-store";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_OUTPUT_LIMIT_BYTES = 64 * 1024;

export function createRuntimeContext(
  options: PipelineRuntimeOptions
): RuntimeContext {
  const worktreePath = options.worktreePath ?? process.cwd();
  const config = options.config ?? loadPipelineConfig(worktreePath);
  const workflowSelection = resolveWorkflowSelection(
    config,
    options.workflowId,
    options.entrypoint
  );
  const plan = compileWorkflowPlan(config, workflowSelection);
  const workflowId = plan.workflowId;
  const runId =
    options.runId ??
    (planReferencesRunIdTemplate(plan) ? generateRuntimeRunId() : undefined);
  const observability = options.reporter
    ? createPublicRuntimeObservabilityEmitter(options.reporter, workflowId)
    : undefined;
  return {
    agentInvocations: [],
    ...(runId ? { runId } : {}),
    config,
    executor: options.executor ?? runLaunchPlan,
    gates: [],
    hookFailures: [],
    hookResults: new Map(),
    hookPolicy: {
      allowCommandHooks: options.hookPolicy?.allowCommandHooks ?? true,
      allowUntrustedCommandHooks:
        options.hookPolicy?.allowUntrustedCommandHooks ?? true,
      env: options.hookPolicy?.env ?? {},
      envPassthrough: options.hookPolicy?.envPassthrough ?? ["PATH"],
      outputLimitBytes:
        options.hookPolicy?.outputLimitBytes ?? DEFAULT_HOOK_OUTPUT_LIMIT_BYTES,
      timeoutMs: options.hookPolicy?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    maxParallelNodes: runtimeMaxParallelNodes(options, plan),
    nodeStateStore: initialNodeStateStore(plan),
    ...(observability ? { observability } : {}),
    plan,
    ...(options.reporter ? { reporter: options.reporter } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    task: options.task,
    ...(options.taskContext ? { taskContext: options.taskContext } : {}),
    workflowId,
    worktreePath,
  };
}

export function resolveWorkflowSelection(
  config: PipelineConfig,
  workflowId?: string,
  entrypointId?: string
): string | undefined {
  if (workflowId) {
    return workflowId;
  }
  if (!entrypointId) {
    return;
  }
  const entrypoint = config.entrypoints[entrypointId];
  if (!entrypoint) {
    throw new Error(`Unknown pipeline entrypoint '${entrypointId}'`);
  }
  if ("schedule" in entrypoint) {
    throw new Error(
      `Pipeline entrypoint '${entrypointId}' generates schedule '${entrypoint.schedule}'; run with --schedule <schedule.yaml> instead.`
    );
  }
  return entrypoint.workflow;
}

function runtimeMaxParallelNodes(
  options: PipelineRuntimeOptions,
  plan: WorkflowExecutionPlan
): number | undefined {
  if (options.maxParallelNodes) {
    return normalizeMaxParallelNodes(options.maxParallelNodes);
  }
  if (plan.execution.maxParallelNodes) {
    return normalizeMaxParallelNodes(plan.execution.maxParallelNodes);
  }
  return;
}

export function normalizeMaxParallelNodes(value: number): number {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error("maxParallelNodes must be a positive integer");
  }
  return value;
}

function planReferencesRunIdTemplate(plan: WorkflowExecutionPlan): boolean {
  return nodesReferenceRunIdTemplate(plan.topologicalOrder);
}

function nodesReferenceRunIdTemplate(nodes: PlannedWorkflowNode[]): boolean {
  return nodes.some((node) => nodesReferenceRunIdTemplate(node.children ?? []));
}

export function generateRuntimeRunId(): string {
  return `run-${randomUUID()}`;
}
