import { Effect, Fiber, Queue } from "effect";
import { fromUndefinedOr, isSome, match, none, some } from "effect/Option";
import type { Option } from "effect/Option";

import { uniqueStrings } from "../strings";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeNodeResult,
} from "./contracts";
import type { RunJournal } from "./run-journal";

export interface WorkflowScheduleNode {
  category?: string;
  dependents: string[];
  id: string;
  index: number;
  needs: string[];
}

export interface FanOutWidth {
  by_category: Record<string, number>;
  default: number;
}

export interface WorkflowSchedulerInput {
  failFast: boolean;
  fanOutWidth?: FanOutWidth;
  isCancelled: () => boolean;
  /**
   * PIPE-83.10: optional durability seam. When provided, the run resumes from
   * the journal's passed nodes (they are not re-run) and every terminal result
   * is recorded. Absent → byte-identical to the prior in-memory behaviour.
   */
  journal?: RunJournal;
  markNodeReady: (nodeId: string) => void;
  maxParallelNodes?: number;
  nodes: WorkflowScheduleNode[];
  runNode: (nodeId: string) => Promise<RuntimeNodeResult>;
  shouldContinueAfterNodeResult: (result: RuntimeNodeResult) => boolean;
  skipNode: (nodeId: string, reason: string) => void;
}

interface WorkflowSchedulerState {
  blocked?: string[];
  completed?: RuntimeNodeResult[];
  failFast?: boolean;
  fanOutWidth?: FanOutWidth;
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

type ActiveSchedulerState = Required<
  Pick<WorkflowSchedulerState, "blocked" | "completed">
> &
  Omit<WorkflowSchedulerState, "blocked" | "completed">;
type WorkflowNodeCategory = Option<string>;

// A node fiber reports exactly one terminal outcome onto the completion queue:
// either its result, or the error its runNode promise rejected with.
type NodeOutcome =
  | { kind: "ok"; result: RuntimeNodeResult }
  | { error: unknown; kind: "error" };

interface SchedulerContext {
  completions: Queue.Queue<NodeOutcome>;
  failure?: RuntimeFailure;
  input: WorkflowSchedulerInput;
  running: Map<string, Fiber.Fiber<void>>;
  state: ActiveSchedulerState;
}

// PIPE-83.10: journal interactions are factored out so the durability seam adds
// no branches to the scheduler loop.
const resumeFromJournal = (
  input: WorkflowSchedulerInput
): RuntimeNodeResult[] => input.journal?.resumeCompleted() ?? [];

const recordToJournal = (
  input: WorkflowSchedulerInput,
  result: RuntimeNodeResult
): void => {
  input.journal?.record(result);
};

const cancelledResult = (
  state: ActiveSchedulerState
): WorkflowSchedulerRunResult => ({
  completed: state.completed,
  outcome: "CANCELLED",
});

const terminalResult = (
  state: ActiveSchedulerState,
  failure?: RuntimeFailure
): WorkflowSchedulerRunResult => ({
  completed: state.completed,
  failure,
  outcome: failure ? "FAIL" : "PASS",
});

// PIPE-83.10: the engine runs on Effect — each node is a forked fiber that
// reports its terminal outcome onto a completion queue. `Queue.take` replaces
// the hand-rolled `Promise.race`, and structured concurrency interrupts the
// in-flight fibers on cancellation or a node-level defect.
const runNodeFiber = (
  ctx: SchedulerContext,
  nodeId: string
): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await ctx.input.runNode(nodeId),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Queue.offer(ctx.completions, { error, kind: "error" }),
      onSuccess: (result) =>
        Queue.offer(ctx.completions, { kind: "ok", result }),
    })
  );

// Nodes already completed or in flight — i.e. claimed, never re-launchable.
const settledNodeIds = (
  context: Pick<WorkflowSchedulerState, "completed" | "running">
): Set<string> => {
  const ids = new Set((context.completed ?? []).map((result) => result.nodeId));
  for (const nodeId of context.running) {
    ids.add(nodeId);
  }
  return ids;
};

/**
 * PIPE-91.6: the readiness computation extracted as a pure exported function so
 * both the scheduler loop and the `moka next node` stepping command reuse it
 * without duplication. The scheduler's internal {@link readyNodeIds} delegates
 * here; callers outside the scheduler (e.g. the stepping command) pass only the
 * fields they have — `running` and `blocked` default to empty when absent.
 */
export interface NodeReadinessInput {
  readonly blocked?: string[];
  readonly completed?: RuntimeNodeResult[];
  readonly nodes: WorkflowScheduleNode[];
  readonly running?: string[];
  readonly shouldContinueAfterNodeResult?: (
    result: RuntimeNodeResult
  ) => boolean;
}

const workflowNodeCapacity = (context: WorkflowSchedulerState): number => {
  const limit =
    context.failFast === true
      ? 1
      : (context.maxParallelNodes ?? context.nodes.length);
  return Math.max(0, limit - context.running.length);
};

const categoryCap = (category: string, fanOut: FanOutWidth): number =>
  fanOut.by_category[category] ?? fanOut.default;

const claimNamedCategorySlot = (
  fanOut: FanOutWidth,
  counts: Map<string, number>,
  category: string
): boolean => {
  const current = counts.get(category) ?? 0;
  if (current >= categoryCap(category, fanOut)) {
    return false;
  }
  counts.set(category, current + 1);
  return true;
};

/**
 * Whether a node of the given category may launch now, consuming a slot from
 * `counts` when it can. Uncategorized nodes always may; a category at its cap
 * may not.
 */
const claimCategorySlot = (
  fanOut: FanOutWidth,
  counts: Map<string, number>,
  category: WorkflowNodeCategory
): boolean =>
  match(category, {
    onNone: () => true,
    onSome: (name) => claimNamedCategorySlot(fanOut, counts, name),
  });

const recordCategoryRun = (
  counts: Map<string, number>,
  category: WorkflowNodeCategory
): void => {
  match(category, {
    onNone: () => {},
    onSome: (name) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return;
    },
  });
};

const categoryRunCounts = (
  running: string[],
  categoryOf: Map<string, WorkflowNodeCategory>
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const nodeId of running) {
    recordCategoryRun(counts, categoryOf.get(nodeId) ?? none());
  }
  return counts;
};

const cappedSelection = (
  ready: string[],
  capacity: number,
  state: WorkflowSchedulerState,
  fanOut: FanOutWidth
): string[] => {
  const categoryOf = new Map(
    state.nodes.map((node): [string, WorkflowNodeCategory] => [
      node.id,
      fromUndefinedOr(node.category),
    ])
  );
  const counts = categoryRunCounts(state.running, categoryOf);
  const selected: string[] = [];
  for (const nodeId of ready) {
    if (selected.length >= capacity) {
      break;
    }
    if (claimCategorySlot(fanOut, counts, categoryOf.get(nodeId) ?? none())) {
      selected.push(nodeId);
    }
  }
  return selected;
};

const isBlockingFailure = (
  result: RuntimeNodeResult,
  context: WorkflowSchedulerState
): boolean =>
  result.status === "failed" &&
  !(context.shouldContinueAfterNodeResult?.(result) ?? false);

const orderedNodes = (nodes: WorkflowScheduleNode[]): WorkflowScheduleNode[] =>
  [...nodes].toSorted((a, b) => a.index - b.index);

const initialSchedulerState = (
  input: WorkflowSchedulerInput
): ActiveSchedulerState => ({
  blocked: [],
  completed: resumeFromJournal(input),
  failFast: input.failFast,
  fanOutWidth: input.fanOutWidth,
  maxParallelNodes: input.maxParallelNodes,
  nodes: orderedNodes(input.nodes),
  running: [],
  shouldContinueAfterNodeResult: input.shouldContinueAfterNodeResult,
});

export const computeReadyNodeIds = (input: NodeReadinessInput): string[] => {
  const completedIds = new Set((input.completed ?? []).map((r) => r.nodeId));
  const runningIds = new Set(input.running);
  const blockedIds = new Set(input.blocked);
  const settled = new Set([...completedIds, ...runningIds]);
  return orderedNodes(input.nodes)
    .filter((node) => !(settled.has(node.id) || blockedIds.has(node.id)))
    .filter((node) =>
      node.needs.every((needId) => {
        const result = (input.completed ?? []).find((r) => r.nodeId === needId);
        if (result === undefined) {
          return false;
        }
        return (
          input.shouldContinueAfterNodeResult?.(result) ??
          result.status !== "failed"
        );
      })
    )
    .map((node) => node.id);
};

const readyNodeIds = (context: WorkflowSchedulerState): string[] =>
  computeReadyNodeIds(context);

/**
 * Choose which ready nodes to launch this tick within the global capacity and
 * the per-category fan-out caps. A category at its cap defers its remaining
 * ready nodes to a later tick (it does not drop them). Nodes without a category
 * are bounded only by the global capacity. Without a fanOutWidth (e.g. in tests
 * or configs with no token_budget), this is the prior `slice(0, capacity)`.
 */
const selectLaunchableNodes = (
  state: WorkflowSchedulerState,
  capacity: number
): string[] => {
  const ready = readyNodeIds(state);
  return state.fanOutWidth === undefined
    ? ready.slice(0, capacity)
    : cappedSelection(ready, capacity, state, state.fanOutWidth);
};

const launchReady = (ctx: SchedulerContext): Effect.Effect<void> =>
  Effect.gen(function* effectBody() {
    const capacity = workflowNodeCapacity(ctx.state);
    if (capacity <= 0) {
      return;
    }
    for (const nodeId of selectLaunchableNodes(ctx.state, capacity)) {
      ctx.input.markNodeReady(nodeId);
      ctx.state.running = [...ctx.state.running, nodeId];
      const fiber = yield* Effect.forkChild(runNodeFiber(ctx, nodeId));
      ctx.running.set(nodeId, fiber);
    }
  });

const unstartedNodeIds = (
  context: Pick<WorkflowSchedulerState, "completed" | "nodes" | "running">
): string[] => {
  const settled = settledNodeIds(context);
  return orderedNodes(context.nodes)
    .map((node) => node.id)
    .filter((nodeId) => !settled.has(nodeId));
};

const applyFailFastSkip = (
  ctx: SchedulerContext,
  result: RuntimeNodeResult
): void => {
  const reason = `skipped because workflow fail_fast stopped after node '${result.nodeId}' failed`;
  const skipped = unstartedNodeIds(ctx.state);
  ctx.state.blocked = uniqueStrings([...ctx.state.blocked, ...skipped]);
  for (const nodeId of skipped) {
    ctx.input.skipNode(nodeId, reason);
  }
};

const directDependents = (
  nodeId: string,
  nodes: WorkflowScheduleNode[]
): string[] => {
  const declared = nodes.find((node) => node.id === nodeId)?.dependents ?? [];
  const inferred = orderedNodes(nodes)
    .filter((node) => node.needs.includes(nodeId))
    .map((node) => node.id);
  const byId = new Map(orderedNodes(nodes).map((node) => [node.id, node]));
  return uniqueStrings([...declared, ...inferred]).toSorted(
    (left, right) =>
      (byId.get(left)?.index ?? 0) - (byId.get(right)?.index ?? 0)
  );
};

const unstartedBlockingDescendants = (
  nodeId: string,
  context: Pick<WorkflowSchedulerState, "completed" | "nodes" | "running">
): string[] => {
  const unstarted = new Set(unstartedNodeIds(context));
  const descendants = new Set<string>();
  const queue = directDependents(nodeId, context.nodes);
  while (queue.length > 0) {
    const descendantId = queue.shift();
    if (descendantId === undefined || descendants.has(descendantId)) {
      continue;
    }
    descendants.add(descendantId);
    queue.push(...directDependents(descendantId, context.nodes));
  }
  return orderedNodes(context.nodes)
    .map((node) => node.id)
    .filter((descendantId) => descendants.has(descendantId))
    .filter((descendantId) => unstarted.has(descendantId));
};

const nodeRuntimeFailure = (node: RuntimeNodeResult): RuntimeFailure => ({
  evidence: node.evidence,
  gate: node.nodeId,
  nodeId: node.nodeId,
  reason: `node '${node.nodeId}' failed`,
});

// Fold one completed node into the run state (mutates ctx), mirroring the prior
// loop body: record it, then on a blocking failure either fail-fast-skip the
// rest or block its descendants.
const applyCompletion = (
  ctx: SchedulerContext,
  result: RuntimeNodeResult
): void => {
  ctx.running.delete(result.nodeId);
  ctx.state.running = ctx.state.running.filter((id) => id !== result.nodeId);
  ctx.state.completed = [...ctx.state.completed, result];
  recordToJournal(ctx.input, result);
  if (!isBlockingFailure(result, ctx.state)) {
    return;
  }
  ctx.failure ??= nodeRuntimeFailure(result);
  if (ctx.input.failFast) {
    applyFailFastSkip(ctx, result);
    return;
  }
  const blocked = unstartedBlockingDescendants(result.nodeId, ctx.state);
  ctx.state.blocked = uniqueStrings([...ctx.state.blocked, ...blocked]);
};

const workflowServiceFailure = (
  error: unknown,
  gate: string
): RuntimeFailure => {
  const reason = error instanceof Error ? error.message : String(error);
  return { evidence: [reason], gate, reason };
};

const nodeErrorResult = (
  state: ActiveSchedulerState,
  error: unknown
): WorkflowSchedulerRunResult => ({
  completed: state.completed,
  failure: workflowServiceFailure(error, "workflow.node"),
  outcome: "FAIL",
});

const applyOutcome = (
  ctx: SchedulerContext,
  outcome: NodeOutcome
): Effect.Effect<Option<WorkflowSchedulerRunResult>> =>
  Effect.gen(function* effectBody() {
    if (outcome.kind === "error") {
      yield* Fiber.interruptAll(ctx.running.values());
      return some(nodeErrorResult(ctx.state, outcome.error));
    }
    applyCompletion(ctx, outcome.result);
    return none();
  });

// One scheduler tick: stop if cancelled, launch newly-ready nodes within the
// caps, then either drain (no fibers left) or await the next completion.
const schedulerTick = (
  ctx: SchedulerContext
): Effect.Effect<Option<WorkflowSchedulerRunResult>> =>
  Effect.gen(function* effectBody() {
    if (ctx.input.isCancelled()) {
      yield* Fiber.interruptAll(ctx.running.values());
      return some(cancelledResult(ctx.state));
    }
    yield* launchReady(ctx);
    if (ctx.running.size === 0) {
      return some(terminalResult(ctx.state, ctx.failure));
    }
    const outcome = yield* Queue.take(ctx.completions);
    return yield* applyOutcome(ctx, outcome);
  });

const schedulerLoop = (
  ctx: SchedulerContext
): Effect.Effect<WorkflowSchedulerRunResult> =>
  Effect.flatMap(schedulerTick(ctx), (done) =>
    isSome(done) ? Effect.succeed(done.value) : schedulerLoop(ctx)
  );

const schedulerProgram = (
  input: WorkflowSchedulerInput
): Effect.Effect<WorkflowSchedulerRunResult> =>
  Effect.gen(function* effectBody() {
    const ctx: SchedulerContext = {
      completions: yield* Queue.unbounded<NodeOutcome>(),
      input,
      running: new Map<string, Fiber.Fiber<void>>(),
      state: initialSchedulerState(input),
    };
    return yield* schedulerLoop(ctx);
  });

export const runWorkflowScheduler = async (
  input: WorkflowSchedulerInput
): Promise<WorkflowSchedulerRunResult> =>
  await Effect.runPromise(schedulerProgram(input));
