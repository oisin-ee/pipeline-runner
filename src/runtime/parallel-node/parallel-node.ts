import { Effect } from "effect";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  NodeAttemptResult,
  RuntimeContext,
  RuntimeNodeResult,
} from "../contracts";
import { childReporter } from "../events";
import { configUsesOpencode, leaseOpencodeRuntime } from "../opencode-runtime";
import type { CreateWorktreeOptions } from "../parallel-worktrees/parallel-worktrees";
import {
  WorktreeService,
  WorktreeServiceLive,
} from "../services/worktree-service";

export interface ParallelNodeRuntime {
  executeNode: (
    node: PlannedWorkflowNode,
    context: RuntimeContext
  ) => Promise<RuntimeNodeResult>;
  markNodeReady: (context: RuntimeContext, nodeId: string) => void;
}

type CategorySemaphores = Map<string, Effect.Semaphore>;

// The fan-out abort controller signals running children (via context.signal) and
// lets queued ones short-circuit when fail-fast trips.
interface FailFastGate {
  abort: () => void;
  aborted: () => boolean;
}

export function executeParallelNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Promise<NodeAttemptResult> {
  return Effect.runPromise(
    Effect.provide(
      parallelNodeProgram(node, context, runtime),
      WorktreeServiceLive
    )
  );
}

function parallelNodeProgram(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Effect.Effect<NodeAttemptResult, never, WorktreeService> {
  const children = node.children ?? [];
  if (children.length === 0) {
    return Effect.succeed({
      evidence: [`parallel node '${node.id}' has no children`],
      exitCode: 1,
      output: "",
    });
  }
  return Effect.gen(function* () {
    yield* gcStaleWorktrees(context);
    const failFast = context.plan.execution.failFast;
    const linkedAbort = createLinkedAbortController(context.signal);
    const childContext = createParallelChildContext(
      context,
      node.id,
      children,
      failFast ? linkedAbort.controller.signal : context.signal
    );
    const gate = failFast
      ? makeFailFastGate(linkedAbort.controller)
      : undefined;
    for (const child of children) {
      runtime.markNodeReady(childContext, child.id);
    }
    const caps = yield* makeCategorySemaphores(childContext);
    const settled = yield* runAllChildren(
      children,
      childContext,
      runtime,
      caps,
      gate
    ).pipe(Effect.ensuring(Effect.sync(linkedAbort.cleanup)));
    return aggregateParallelResult(node.id, children, settled);
  });
}

function makeFailFastGate(controller: AbortController): FailFastGate {
  return {
    abort: () => controller.abort(),
    aborted: () => controller.signal.aborted,
  };
}

function aggregateParallelResult(
  nodeId: string,
  children: PlannedWorkflowNode[],
  settled: Array<RuntimeNodeResult | undefined>
): NodeAttemptResult {
  const results = settled.filter(
    (result): result is RuntimeNodeResult => result !== undefined
  );
  const failed = results.filter((result) => result.status === "failed");
  return {
    evidence: parallelEvidence(nodeId, results, failed),
    exitCode: failed.length > 0 ? 1 : 0,
    output: parallelOutput(children, results),
  };
}

function runAllChildren(
  children: PlannedWorkflowNode[],
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  caps: CategorySemaphores,
  gate: FailFastGate | undefined
): Effect.Effect<Array<RuntimeNodeResult | undefined>, never, WorktreeService> {
  return Effect.forEach(
    children,
    (child) => runChildCapped(child, context, runtime, caps, gate),
    { concurrency: context.maxParallelNodes ?? "unbounded" }
  );
}

// One child: skip if fail-fast already tripped, otherwise run it under its
// category cap and trip the gate on failure. `undefined` = skipped (excluded
// from results, mirroring the prior clearQueue behaviour).
function runChildCapped(
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  caps: CategorySemaphores,
  gate: FailFastGate | undefined
): Effect.Effect<RuntimeNodeResult | undefined, never, WorktreeService> {
  return Effect.gen(function* () {
    if (gate?.aborted()) {
      return;
    }
    const result = yield* withCategoryCap(
      caps,
      child.id,
      context,
      runChildInWorktree(child, context, runtime)
    );
    if (gate && result.status === "failed") {
      gate.abort();
    }
    return result;
  });
}

function withCategoryCap(
  caps: CategorySemaphores,
  childId: string,
  context: RuntimeContext,
  effect: Effect.Effect<RuntimeNodeResult, never, WorktreeService>
): Effect.Effect<RuntimeNodeResult, never, WorktreeService> {
  const category = childCategory(
    childId,
    context.config.token_budget?.fan_out_width
  );
  const semaphore = category ? caps.get(category) : undefined;
  return semaphore ? semaphore.withPermits(1)(effect) : effect;
}

// PIPE-83.7 AC3: per-category fan-out caps as Effect semaphores keyed by the
// token_budget.fan_out_width categories (e.g. green=2), so N candidates of a
// category never exceed its cap even within the global maxParallelNodes.
function makeCategorySemaphores(
  context: RuntimeContext
): Effect.Effect<CategorySemaphores> {
  const fanOut = context.config.token_budget?.fan_out_width;
  if (!fanOut) {
    return Effect.succeed(new Map());
  }
  return Effect.gen(function* () {
    const caps: CategorySemaphores = new Map();
    for (const [category, permits] of Object.entries(fanOut.by_category)) {
      caps.set(category, yield* Effect.makeSemaphore(permits));
    }
    return caps;
  });
}

function gcStaleWorktrees(
  context: RuntimeContext
): Effect.Effect<void, never, WorktreeService> {
  return Effect.gen(function* () {
    if (context.config.parallel_worktrees?.enabled) {
      const worktree = yield* WorktreeService;
      yield* worktree.gc(context.worktreePath);
    }
  });
}

/**
 * PIPE-83.4: run a parallel child in its own git worktree when enabled, so
 * concurrent candidate edits can't collide. The worktree lease is acquired and
 * released as an Effect-scoped resource (released on success, failure, or
 * interruption); release retains dirty/unpushed work for downstream selection.
 */
function runChildInWorktree(
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Effect.Effect<RuntimeNodeResult, never, WorktreeService> {
  if (!context.config.parallel_worktrees?.enabled) {
    return executeChild(child, context, runtime);
  }
  return Effect.gen(function* () {
    const worktree = yield* WorktreeService;
    return yield* Effect.acquireUseRelease(
      worktree.createChild(childLeaseOptions(child, context)),
      (lease) => runChildWithWorktreeLease(child, context, runtime, lease.path),
      (lease) => Effect.sync(() => lease.release())
    );
  });
}

function executeChild(
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime
): Effect.Effect<RuntimeNodeResult, never> {
  return Effect.tryPromise(() => runtime.executeNode(child, context)).pipe(
    Effect.orDie
  );
}

function runChildWithWorktreeLease(
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  worktreePath: string
): Effect.Effect<RuntimeNodeResult, never> {
  const childContext = { ...context, worktreePath };
  if (!configUsesOpencode(context.config)) {
    return executeChild(child, childContext, runtime);
  }
  return Effect.acquireUseRelease(
    leaseChildOpencodeRuntime(context, worktreePath),
    (childRuntime) =>
      executeChild(
        child,
        { ...childContext, executor: childRuntime.executor },
        runtime
      ),
    (childRuntime) =>
      Effect.tryPromise(() => childRuntime.release()).pipe(Effect.orDie)
  );
}

function leaseChildOpencodeRuntime(
  context: RuntimeContext,
  worktreePath: string
) {
  return Effect.tryPromise(() =>
    leaseOpencodeRuntime({
      config: context.config,
      ...(context.signal ? { signal: context.signal } : {}),
      worktreePath,
    })
  ).pipe(Effect.orDie);
}

function childLeaseOptions(
  child: PlannedWorkflowNode,
  context: RuntimeContext
): CreateWorktreeOptions {
  return {
    childNodeId: child.id,
    parentNodeId: context.parentParallelNodeId ?? "parallel",
    repoRoot: context.worktreePath,
    ...(context.runId ? { runId: context.runId } : {}),
  };
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

// PIPE-83.7 AC3: a parallel node's children (e.g. best-of-N candidates) are
// throttled by their category's token_budget.fan_out_width cap, not just the
// global maxParallelNodes — so N green candidates respect green=2.
// fallow-ignore-next-line unused-export
export function childCategory(
  childId: string,
  fanOut: PipelineConfig["token_budget"]["fan_out_width"] | undefined
): string | undefined {
  return fanOut
    ? Object.keys(fanOut.by_category).find((category) =>
        childId.includes(category)
      )
    : undefined;
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
