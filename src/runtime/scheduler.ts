import type { WorkflowExecutionPlan } from "../planning/compile";
import { uniqueStrings } from "../strings";
import type {
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeNodeResult,
} from "./contracts";
import {
  runWorkflowLifecycle,
  type WorkflowHookEvent,
} from "./workflow-lifecycle";

export interface PipelineScheduler {
  runWorkflow(
    plan: WorkflowExecutionPlan,
    context: RuntimeContext
  ): Promise<PipelineRuntimeResult>;
}

export interface LocalSchedulerOptions {
  buildResult: (
    outcome: PipelineRuntimeResult["outcome"],
    nodes: RuntimeNodeResult[],
    failure?: RuntimeFailure
  ) => PipelineRuntimeResult;
  emitWorkflowPlanned: (context: RuntimeContext) => void;
  emitWorkflowStarted: (context: RuntimeContext) => void;
  executeNode: (
    nodeId: string,
    context: RuntimeContext
  ) => Promise<RuntimeNodeResult>;
  isCancelled: (context: RuntimeContext) => boolean;
  markNodeReady: (nodeId: string, context: RuntimeContext) => void;
  runWorkflowHook: (
    event: WorkflowHookEvent,
    failure: RuntimeFailure | undefined,
    context: RuntimeContext
  ) => Promise<RuntimeFailure | null> | RuntimeFailure | null;
  shouldContinueAfterNodeResult: (
    result: RuntimeNodeResult,
    context: RuntimeContext
  ) => boolean;
  skipNode: (nodeId: string, reason: string, context: RuntimeContext) => void;
}

export class LocalScheduler implements PipelineScheduler {
  private readonly options?: LocalSchedulerOptions;

  constructor(options?: LocalSchedulerOptions) {
    this.options = options;
  }

  async runWorkflow(
    plan: WorkflowExecutionPlan,
    context: RuntimeContext
  ): Promise<PipelineRuntimeResult> {
    const options = this.options;
    if (!options) {
      throw new Error(
        "LocalScheduler requires runtime options to run workflow"
      );
    }

    const lifecycle = await runWorkflowLifecycle({
      buildResult: options.buildResult,
      emitWorkflowPlanned: () => options.emitWorkflowPlanned(context),
      emitWorkflowStarted: () => options.emitWorkflowStarted(context),
      executeWorkflow: () =>
        runWorkflowScheduler({
          failFast: plan.execution.failFast,
          isCancelled: () => options.isCancelled(context),
          markNodeReady: (nodeId) => options.markNodeReady(nodeId, context),
          maxParallelNodes: context.maxParallelNodes,
          nodes: plan.topologicalOrder.map((node) => ({
            dependents: node.dependents,
            id: node.id,
            index: node.index,
            needs: node.needs,
          })),
          runNode: (nodeId) => options.executeNode(nodeId, context),
          shouldContinueAfterNodeResult: (result) =>
            options.shouldContinueAfterNodeResult(result, context),
          skipNode: (nodeId, reason) =>
            options.skipNode(nodeId, reason, context),
        }),
      isCancelled: () => options.isCancelled(context),
      runWorkflowHook: (event, failure) =>
        options.runWorkflowHook(event, failure, context),
    });

    return lifecycle.result;
  }
}

export interface WorkflowScheduleNode {
  dependents: string[];
  id: string;
  index: number;
  needs: string[];
}

export interface WorkflowSchedulerInput {
  failFast: boolean;
  isCancelled: () => boolean;
  markNodeReady: (nodeId: string) => void;
  maxParallelNodes?: number;
  nodes: WorkflowScheduleNode[];
  runNode: (nodeId: string) => Promise<RuntimeNodeResult>;
  shouldContinueAfterNodeResult: (result: RuntimeNodeResult) => boolean;
  skipNode: (nodeId: string, reason: string) => void;
}

export interface WorkflowSchedulerState {
  blocked?: string[];
  completed?: RuntimeNodeResult[];
  failFast?: boolean;
  maxParallelNodes?: number;
  nodes: WorkflowScheduleNode[];
  running: string[];
  shouldContinueAfterNodeResult?: (result: RuntimeNodeResult) => boolean;
}

export interface WorkflowSchedulerRunResult {
  completed: RuntimeNodeResult[];
  failure?: RuntimeFailure;
  outcome: PipelineRuntimeResult["outcome"];
}

interface RunningNode {
  nodeId: string;
  promise: Promise<RuntimeNodeResult>;
}

export async function runWorkflowScheduler(
  input: WorkflowSchedulerInput
): Promise<WorkflowSchedulerRunResult> {
  const state: Required<Pick<WorkflowSchedulerState, "blocked" | "completed">> &
    Omit<WorkflowSchedulerState, "blocked" | "completed"> = {
    blocked: [],
    completed: [],
    failFast: input.failFast,
    maxParallelNodes: input.maxParallelNodes,
    nodes: orderedNodes(input.nodes),
    running: [],
    shouldContinueAfterNodeResult: input.shouldContinueAfterNodeResult,
  };
  const running = new Map<string, RunningNode>();
  let failure: RuntimeFailure | undefined;

  while (true) {
    if (input.isCancelled()) {
      return { completed: state.completed, outcome: "CANCELLED" };
    }

    launchReadyNodes(input, state, running);

    if (running.size === 0) {
      return {
        completed: state.completed,
        failure,
        outcome: failure ? "FAIL" : "PASS",
      };
    }

    let result: RuntimeNodeResult;
    try {
      result = await Promise.race(
        [...running.values()].map(({ promise }) => promise)
      );
    } catch (error: unknown) {
      return {
        completed: state.completed,
        failure: workflowServiceFailure(error, "workflow.node"),
        outcome: "FAIL",
      };
    }

    running.delete(result.nodeId);
    state.running = state.running.filter((nodeId) => nodeId !== result.nodeId);
    state.completed = [...state.completed, result];

    if (!isBlockingFailure(result, state)) {
      continue;
    }

    failure ??= nodeRuntimeFailure(result);
    if (input.failFast) {
      const reason = `skipped because workflow fail_fast stopped after node '${result.nodeId}' failed`;
      const skipped = unstartedNodeIds(state);
      state.blocked = uniqueStrings([...state.blocked, ...skipped]);
      for (const nodeId of skipped) {
        input.skipNode(nodeId, reason);
      }
      continue;
    }

    const blocked = unstartedBlockingDescendants(result.nodeId, state);
    state.blocked = uniqueStrings([...state.blocked, ...blocked]);
  }
}

export function readyNodeIds(context: WorkflowSchedulerState): string[] {
  const blocked = new Set(context.blocked ?? []);
  const completed = new Set(
    (context.completed ?? []).map((result) => result.nodeId)
  );
  const running = new Set(context.running);
  return orderedNodes(context.nodes)
    .filter((node) => !completed.has(node.id))
    .filter((node) => !running.has(node.id))
    .filter((node) => !blocked.has(node.id))
    .filter((node) =>
      node.needs.every((need) => dependencyPassed(need, context))
    )
    .map((node) => node.id);
}

export function workflowNodeCapacity(context: WorkflowSchedulerState): number {
  const limit = context.failFast
    ? 1
    : (context.maxParallelNodes ?? context.nodes.length);
  return Math.max(0, limit - context.running.length);
}

export function unstartedBlockingDescendants(
  nodeId: string,
  context: Pick<WorkflowSchedulerState, "completed" | "nodes" | "running">
): string[] {
  const unstarted = new Set(unstartedNodeIds(context));
  const descendants = new Set<string>();
  const queue = directDependents(nodeId, context.nodes);
  while (queue.length > 0) {
    const descendantId = queue.shift();
    if (!descendantId || descendants.has(descendantId)) {
      continue;
    }
    descendants.add(descendantId);
    queue.push(...directDependents(descendantId, context.nodes));
  }
  return orderedNodes(context.nodes)
    .map((node) => node.id)
    .filter((descendantId) => descendants.has(descendantId))
    .filter((descendantId) => unstarted.has(descendantId));
}

function launchReadyNodes(
  input: WorkflowSchedulerInput,
  state: WorkflowSchedulerState,
  running: Map<string, RunningNode>
): void {
  const capacity = workflowNodeCapacity(state);
  if (capacity <= 0) {
    return;
  }
  for (const nodeId of readyNodeIds(state).slice(0, capacity)) {
    input.markNodeReady(nodeId);
    state.running = [...state.running, nodeId];
    running.set(nodeId, { nodeId, promise: input.runNode(nodeId) });
  }
}

function dependencyPassed(
  nodeId: string,
  context: WorkflowSchedulerState
): boolean {
  const result = (context.completed ?? []).find(
    (item) => item.nodeId === nodeId
  );
  return result
    ? (context.shouldContinueAfterNodeResult?.(result) ??
        result.status !== "failed")
    : false;
}

function isBlockingFailure(
  result: RuntimeNodeResult,
  context: WorkflowSchedulerState
): boolean {
  return (
    result.status === "failed" &&
    !(context.shouldContinueAfterNodeResult?.(result) ?? false)
  );
}

function unstartedNodeIds(
  context: Pick<WorkflowSchedulerState, "completed" | "nodes" | "running">
): string[] {
  const completed = new Set(
    (context.completed ?? []).map((result) => result.nodeId)
  );
  const running = new Set(context.running);
  return orderedNodes(context.nodes)
    .map((node) => node.id)
    .filter((nodeId) => !completed.has(nodeId))
    .filter((nodeId) => !running.has(nodeId));
}

function directDependents(
  nodeId: string,
  nodes: WorkflowScheduleNode[]
): string[] {
  const declared = nodes.find((node) => node.id === nodeId)?.dependents ?? [];
  const inferred = orderedNodes(nodes)
    .filter((node) => node.needs.includes(nodeId))
    .map((node) => node.id);
  const byId = new Map(orderedNodes(nodes).map((node) => [node.id, node]));
  return uniqueStrings([...declared, ...inferred]).sort(
    (left, right) =>
      (byId.get(left)?.index ?? 0) - (byId.get(right)?.index ?? 0)
  );
}

function orderedNodes(nodes: WorkflowScheduleNode[]): WorkflowScheduleNode[] {
  return [...nodes].sort((a, b) => a.index - b.index);
}

function nodeRuntimeFailure(node: RuntimeNodeResult): RuntimeFailure {
  return {
    evidence: node.evidence,
    gate: node.nodeId,
    nodeId: node.nodeId,
    reason: `node '${node.nodeId}' failed`,
  };
}

function workflowServiceFailure(error: unknown, gate: string): RuntimeFailure {
  const reason = error instanceof Error ? error.message : String(error);
  return { evidence: [reason], gate, reason };
}
