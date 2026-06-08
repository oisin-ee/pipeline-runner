import pLimit from "p-limit";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import type {
  NodeAttemptResult,
  RuntimeContext,
  RuntimeNodeResult,
} from "../contracts";
import { childReporter } from "../events";

export interface ParallelNodeRuntime {
  executeNode: (
    node: PlannedWorkflowNode,
    context: RuntimeContext
  ) => Promise<RuntimeNodeResult>;
  isDrainMergeNode: (node: PlannedWorkflowNode | undefined) => boolean;
  markNodeReady: (context: RuntimeContext, nodeId: string) => void;
}

export async function executeParallelNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Promise<NodeAttemptResult> {
  const children = node.children ?? [];
  if (children.length === 0) {
    return {
      evidence: [`parallel node '${node.id}' has no children`],
      exitCode: 1,
      output: "",
    };
  }

  const linkedAbort = createLinkedAbortController(context.signal);
  const childContext = createParallelChildContext(
    context,
    node.id,
    children,
    context.plan.execution.failFast
      ? linkedAbort.controller.signal
      : context.signal,
    runtime
  );
  try {
    const results = context.plan.execution.failFast
      ? await executeFailFastParallelChildren(
          children,
          childContext,
          linkedAbort.controller,
          runtime
        )
      : await executeParallelChildren(children, childContext, runtime);
    const failed = results.filter((result) => result.status === "failed");
    return {
      evidence: parallelEvidence(node.id, results, failed),
      exitCode: failed.length > 0 ? 1 : 0,
      output: parallelOutput(children, results),
    };
  } finally {
    linkedAbort.cleanup();
  }
}

function createParallelChildContext(
  context: RuntimeContext,
  parentNodeId: string,
  children: PlannedWorkflowNode[],
  signal: AbortSignal | undefined,
  runtime: ParallelNodeRuntime
): RuntimeContext {
  return {
    ...context,
    inheritedOutputNodeIds: new Set(context.lastOutputByNode.keys()),
    hookResults: new Map(context.hookResults),
    lastOutputByNode: new Map(context.lastOutputByNode),
    nodeSnapshots: new Map(),
    nodeActors: new Map(),
    nodeStates: new Map(
      children.map((child) => [
        child.id,
        {
          attempts: 0,
          evidence: [],
          gates: [],
          id: child.id,
          status: "pending",
        },
      ])
    ),
    plan: {
      ...context.plan,
      parallelBatches: [children],
      topologicalOrder: children,
    },
    parentParallelNodeId: parentNodeId,
    preserveSuccessfulWorkflowWorktrees:
      context.preserveSuccessfulWorkflowWorktrees ||
      parallelFeedsDrainMerge(parentNodeId, context, runtime),
    reporter: childReporter(context, parentNodeId),
    ...(signal ? { signal } : {}),
  };
}

function parallelFeedsDrainMerge(
  parentNodeId: string,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): boolean {
  const parent = context.plan.graph.node(parentNodeId);
  return (
    parent?.dependents.length > 0 &&
    parent.dependents.every((dependentId) =>
      runtime.isDrainMergeNode(context.plan.graph.node(dependentId))
    )
  );
}

function createLinkedAbortController(signal?: AbortSignal): {
  cleanup: () => void;
  controller: AbortController;
} {
  const controller = new AbortController();
  if (!signal) {
    return { cleanup: () => undefined, controller };
  }
  if (signal.aborted) {
    controller.abort();
    return { cleanup: () => undefined, controller };
  }
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return {
    cleanup: () => signal.removeEventListener("abort", abort),
    controller,
  };
}

function executeParallelChildren(
  children: PlannedWorkflowNode[],
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Promise<RuntimeNodeResult[]> {
  for (const child of children) {
    runtime.markNodeReady(context, child.id);
  }
  if (!context.maxParallelNodes) {
    return Promise.all(
      children.map((child) => runtime.executeNode(child, context))
    );
  }
  const limit = pLimit(context.maxParallelNodes);
  return Promise.all(
    children.map((child) => limit(() => runtime.executeNode(child, context)))
  );
}

async function executeFailFastParallelChildren(
  children: PlannedWorkflowNode[],
  context: RuntimeContext,
  abortController: AbortController,
  runtime: ParallelNodeRuntime
): Promise<RuntimeNodeResult[]> {
  for (const child of children) {
    runtime.markNodeReady(context, child.id);
  }
  const limit = pLimit({
    concurrency: context.maxParallelNodes ?? children.length,
    rejectOnClear: true,
  });
  const settled = await Promise.allSettled(
    children.map((child) =>
      limit(async () => {
        const result = await runtime.executeNode(child, context);
        if (result.status === "failed") {
          abortController.abort();
          limit.clearQueue();
        }
        return result;
      })
    )
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
}

export function parallelEvidence(
  nodeId: string,
  results: RuntimeNodeResult[],
  failed: RuntimeNodeResult[]
): string[] {
  if (failed.length === 0) {
    return [
      `parallel node '${nodeId}' completed ${results.length} child nodes`,
    ];
  }
  return [
    `parallel node '${nodeId}' failed with ${failed.length} failed child nodes`,
    ...failed.flatMap((result) => result.evidence),
  ];
}

export function parallelOutput(
  children: PlannedWorkflowNode[],
  results: RuntimeNodeResult[]
): string {
  const outputsByNode = new Map(
    results.map((result) => [result.nodeId, result.output])
  );
  return JSON.stringify({
    children: Object.fromEntries(
      children
        .filter((child) => outputsByNode.has(child.id))
        .map((child) => [child.id, outputsByNode.get(child.id)])
    ),
  });
}
