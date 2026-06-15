import pLimit from "p-limit";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  NodeAttemptResult,
  RuntimeContext,
  RuntimeNodeResult,
} from "../contracts";
import { childReporter } from "../events";
import {
  createChildWorktree,
  gcParallelWorktrees,
  type WorktreeLease,
} from "../parallel-worktrees/parallel-worktrees";

export interface ParallelNodeRuntime {
  executeNode: (
    node: PlannedWorkflowNode,
    context: RuntimeContext
  ) => Promise<RuntimeNodeResult>;
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

  gcStaleWorktrees(context);
  const linkedAbort = createLinkedAbortController(context.signal);
  const childContext = createParallelChildContext(
    context,
    node.id,
    children,
    context.plan.execution.failFast
      ? linkedAbort.controller.signal
      : context.signal
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

function gcStaleWorktrees(context: RuntimeContext): void {
  if (context.config.parallel_worktrees?.enabled) {
    gcParallelWorktrees(context.worktreePath);
  }
}

/**
 * PIPE-83.4: run a parallel child in its own git worktree when enabled, so
 * concurrent candidate edits can't collide. The lease is created inside the
 * per-child callback (not before scheduling) so failFast-cleared children never
 * allocate a worktree; release retains dirty/unpushed work for downstream
 * selection. Default-off path is byte-identical to the prior behaviour.
 */
function runChildInWorktree(
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Promise<RuntimeNodeResult> {
  return context.config.parallel_worktrees?.enabled
    ? runInLease(child, context, runtime, createChildLease(child, context))
    : runtime.executeNode(child, context);
}

function createChildLease(
  child: PlannedWorkflowNode,
  context: RuntimeContext
): WorktreeLease {
  return createChildWorktree({
    childNodeId: child.id,
    parentNodeId: context.parentParallelNodeId ?? "parallel",
    repoRoot: context.worktreePath,
    ...(context.runId ? { runId: context.runId } : {}),
  });
}

async function runInLease(
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  lease: WorktreeLease
): Promise<RuntimeNodeResult> {
  try {
    return await runtime.executeNode(child, {
      ...context,
      worktreePath: lease.path,
    });
  } finally {
    lease.release();
  }
}

function createParallelChildContext(
  context: RuntimeContext,
  parentNodeId: string,
  children: PlannedWorkflowNode[],
  signal: AbortSignal | undefined
): RuntimeContext {
  return {
    ...context,
    hookResults: new Map(context.hookResults),
    nodeStateStore: context.nodeStateStore.forkForParallelChildren(children),
    plan: {
      ...context.plan,
      parallelBatches: [children],
      topologicalOrder: children,
    },
    parentParallelNodeId: parentNodeId,
    reporter: childReporter(context, parentNodeId),
    ...(signal ? { signal } : {}),
  };
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
      children.map((child) => runChildInWorktree(child, context, runtime))
    );
  }
  const limit = pLimit(context.maxParallelNodes);
  return Promise.all(
    children.map((child) =>
      limit(() => runChildInWorktree(child, context, runtime))
    )
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
        const result = await runChildInWorktree(child, context, runtime);
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

// fallow-ignore-next-line unused-export
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

// fallow-ignore-next-line unused-export
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
