import { Effect, Option, Semaphore } from "effect";

import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext, RuntimeNodeResult } from "../contracts";
import { childReporter } from "../events";
import { configUsesOpencode, leaseOpencodeRuntime } from "../opencode-runtime";
import type { CreateWorktreeOptions } from "../parallel-worktrees/parallel-worktrees";
import { WorktreeService, WorktreeServiceLive } from "../services/worktree-service";

export interface ParallelNodeRuntime {
  executeNode: (node: PlannedWorkflowNode, context: RuntimeContext) => Promise<RuntimeNodeResult>;
  markNodeReady: (context: RuntimeContext, nodeId: string) => void;
}

type CategorySemaphores = Map<string, Semaphore.Semaphore>;

// The fan-out abort controller signals running children (via context.signal) and
// lets queued ones short-circuit when fail-fast trips.
interface FailFastGate {
  abort: () => void;
  aborted: () => boolean;
}

const makeFailFastGate = (controller: AbortController): FailFastGate => ({
  abort: () => {
    controller.abort();
  },
  aborted: () => controller.signal.aborted,
});

// PIPE-83.7 AC3: per-category fan-out caps as Effect semaphores keyed by the
// token_budget.fan_out_width categories (e.g. green=2), so N candidates of a
// category never exceed its cap even within the global maxParallelNodes.
const makeCategorySemaphores = (context: RuntimeContext): Effect.Effect<CategorySemaphores> => {
  const fanOut = context.config.token_budget.fan_out_width;
  return Effect.gen(function* effectBody() {
    const caps: CategorySemaphores = new Map();
    for (const [category, permits] of Object.entries(fanOut.by_category)) {
      caps.set(category, yield* Semaphore.make(permits));
    }
    return caps;
  });
};

const gcStaleWorktrees = (context: RuntimeContext): Effect.Effect<void, never, WorktreeService> =>
  Effect.gen(function* effectBody() {
    if (context.config.parallel_worktrees?.enabled === true) {
      const worktree = yield* WorktreeService;
      yield* worktree.gc(context.worktreePath);
    }
  });

const executeChild = (
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
): Effect.Effect<RuntimeNodeResult> =>
  Effect.tryPromise(async () => await runtime.executeNode(child, context)).pipe(Effect.orDie);

const opencodeSessionReporter =
  (context: RuntimeContext): ((nodeId: string, sessionId: string) => void) =>
  (nodeId, sessionId) => {
    context.reporter?.({ nodeId, sessionId, type: "node.session" });
  };

const leaseChildOpencodeRuntime = (context: RuntimeContext, worktreePath: string) =>
  Effect.tryPromise(
    async () =>
      await leaseOpencodeRuntime({
        config: context.config,
        ...(context.reporter === undefined ? {} : { onSession: opencodeSessionReporter(context) }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        worktreePath,
      }),
  ).pipe(Effect.orDie);

const runChildWithWorktreeLease = (
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  worktreePath: string,
): Effect.Effect<RuntimeNodeResult> => {
  const childContext = { ...context, worktreePath };
  if (!configUsesOpencode(context.config)) {
    return executeChild(child, childContext, runtime);
  }
  return Effect.acquireUseRelease(
    leaseChildOpencodeRuntime(context, worktreePath),
    (childRuntime) => executeChild(child, { ...childContext, executor: childRuntime.executor }, runtime),
    (childRuntime) =>
      Effect.tryPromise(async () => {
        await childRuntime.release();
      }).pipe(Effect.orDie),
  );
};

const childLeaseOptions = (child: PlannedWorkflowNode, context: RuntimeContext): CreateWorktreeOptions => ({
  childNodeId: child.id,
  parentNodeId: context.parentParallelNodeId ?? "parallel",
  repoRoot: context.worktreePath,
  ...(context.runId === undefined || context.runId.length === 0 ? {} : { runId: context.runId }),
});

/**
 * PIPE-83.4: run a parallel child in its own git worktree when enabled, so
 * concurrent candidate edits can't collide. The worktree lease is acquired and
 * released as an Effect-scoped resource (released on success, failure, or
 * interruption); release retains dirty/unpushed work for downstream selection.
 */
const runChildInWorktree = (
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
): Effect.Effect<RuntimeNodeResult, never, WorktreeService> => {
  if (context.config.parallel_worktrees?.enabled !== true) {
    return executeChild(child, context, runtime);
  }
  return Effect.gen(function* effectBody() {
    const worktree = yield* WorktreeService;
    return yield* Effect.acquireUseRelease(
      worktree.createChild(childLeaseOptions(child, context)),
      (lease) => runChildWithWorktreeLease(child, context, runtime, lease.path),
      (lease) => Effect.sync(() => lease.release()),
    );
  });
};

const createParallelChildContext = (
  context: RuntimeContext,
  parentNodeId: string,
  children: PlannedWorkflowNode[],
  signal?: AbortSignal,
): RuntimeContext => ({
  ...context,
  hookResults: new Map(context.hookResults),
  nodeStateStore: context.nodeStateStore.forkForParallelChildren(children),
  parentParallelNodeId: parentNodeId,
  plan: {
    ...context.plan,
    parallelBatches: [children],
    topologicalOrder: children,
  },
  reporter: childReporter(context, parentNodeId),
  ...(signal === undefined ? {} : { signal }),
});

const createLinkedAbortController = (
  signal?: AbortSignal,
): {
  cleanup: () => void;
  controller: AbortController;
} => {
  const controller = new AbortController();
  if (signal === undefined) {
    return {
      cleanup: () => {
        /* empty */
      },
      controller,
    };
  }
  if (signal.aborted) {
    controller.abort();
    return {
      cleanup: () => {
        /* empty */
      },
      controller,
    };
  }
  const abort = () => {
    controller.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    cleanup: () => {
      signal.removeEventListener("abort", abort);
    },
    controller,
  };
};

// PIPE-83.7 AC3: a parallel node's children (e.g. best-of-N candidates) are
// throttled by their category's token_budget.fan_out_width cap, not just the
// global maxParallelNodes — so N green candidates respect green=2.
const childCategory = (
  childId: string,
  fanOut?: PipelineConfig["token_budget"]["fan_out_width"],
): Option.Option<string> =>
  fanOut === undefined
    ? Option.none()
    : Option.fromUndefinedOr(Object.keys(fanOut.by_category).find((category) => childId.includes(category)));

const withCategoryCap = (
  caps: CategorySemaphores,
  childId: string,
  context: RuntimeContext,
  effect: Effect.Effect<RuntimeNodeResult, never, WorktreeService>,
): Effect.Effect<RuntimeNodeResult, never, WorktreeService> => {
  const category = childCategory(childId, context.config.token_budget.fan_out_width);
  const semaphore = Option.flatMap(category, (value) => Option.fromUndefinedOr(caps.get(value)));
  return Option.match(semaphore, {
    onNone: () => effect,
    onSome: (value) => value.withPermits(1)(effect),
  });
};

// One child: skip if fail-fast already tripped, otherwise run it under its
// category cap and trip the gate on failure. `undefined` = skipped (excluded
// from results, mirroring the prior clearQueue behaviour).
const runChildCapped = (
  child: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  caps: CategorySemaphores,
  gate?: FailFastGate,
): Effect.Effect<Option.Option<RuntimeNodeResult>, never, WorktreeService> =>
  Effect.gen(function* effectBody() {
    if (gate !== undefined && gate.aborted()) {
      return Option.none();
    }
    const result = yield* withCategoryCap(caps, child.id, context, runChildInWorktree(child, context, runtime));
    if (gate !== undefined && result.status === "failed") {
      gate.abort();
    }
    return Option.some(result);
  });

const runAllChildren = (
  children: PlannedWorkflowNode[],
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
  caps: CategorySemaphores,
  gate?: FailFastGate,
): Effect.Effect<Option.Option<RuntimeNodeResult>[], never, WorktreeService> =>
  Effect.forEach(children, (child) => runChildCapped(child, context, runtime, caps, gate), {
    concurrency: context.maxParallelNodes ?? "unbounded",
  });

const parallelEvidence = (nodeId: string, results: RuntimeNodeResult[], failed: RuntimeNodeResult[]): string[] => {
  if (failed.length === 0) {
    return [`parallel node '${nodeId}' completed ${results.length} child nodes`];
  }
  return [
    `parallel node '${nodeId}' failed with ${failed.length} failed child nodes`,
    ...failed.flatMap((result) => result.evidence),
  ];
};

const parallelOutput = (children: PlannedWorkflowNode[], results: RuntimeNodeResult[]): string => {
  const outputsByNode = new Map(results.map((result) => [result.nodeId, result.output]));
  return JSON.stringify({
    children: Object.fromEntries(
      children.filter((child) => outputsByNode.has(child.id)).map((child) => [child.id, outputsByNode.get(child.id)]),
    ),
  });
};

const aggregateParallelResult = (
  nodeId: string,
  children: PlannedWorkflowNode[],
  settled: Option.Option<RuntimeNodeResult>[],
): NodeAttemptResult => {
  const results = settled.filter(Option.isSome).map((result) => result.value);
  const failed = results.filter((result) => result.status === "failed");
  return {
    evidence: parallelEvidence(nodeId, results, failed),
    exitCode: failed.length > 0 ? 1 : 0,
    output: parallelOutput(children, results),
  };
};

const parallelNodeProgram = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
): Effect.Effect<NodeAttemptResult, never, WorktreeService> => {
  const children = node.children ?? [];
  if (children.length === 0) {
    return Effect.succeed({
      evidence: [`parallel node '${node.id}' has no children`],
      exitCode: 1,
      output: "",
    });
  }
  return Effect.gen(function* effectBody() {
    yield* gcStaleWorktrees(context);
    const { failFast } = context.plan.execution;
    const linkedAbort = createLinkedAbortController(context.signal);
    const childContext = createParallelChildContext(
      context,
      node.id,
      children,
      failFast ? linkedAbort.controller.signal : context.signal,
    );
    const gate = failFast ? makeFailFastGate(linkedAbort.controller) : undefined;
    for (const child of children) {
      runtime.markNodeReady(childContext, child.id);
    }
    const caps = yield* makeCategorySemaphores(childContext);
    const settled = yield* runAllChildren(children, childContext, runtime, caps, gate).pipe(
      Effect.ensuring(Effect.sync(linkedAbort.cleanup)),
    );
    return aggregateParallelResult(node.id, children, settled);
  });
};

export const executeParallelNode = async (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  runtime: ParallelNodeRuntime,
): Promise<NodeAttemptResult> =>
  await Effect.runPromise(Effect.provide(parallelNodeProgram(node, context, runtime), WorktreeServiceLive));
