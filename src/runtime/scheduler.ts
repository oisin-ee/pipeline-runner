import { Effect, Fiber, Queue } from "effect";
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
function resumeFromJournal(input: WorkflowSchedulerInput): RuntimeNodeResult[] {
  return input.journal?.resumeCompleted() ?? [];
}

function recordToJournal(
  input: WorkflowSchedulerInput,
  result: RuntimeNodeResult
): void {
  input.journal?.record(result);
}

function initialSchedulerState(
  input: WorkflowSchedulerInput
): ActiveSchedulerState {
  return {
    blocked: [],
    completed: resumeFromJournal(input),
    failFast: input.failFast,
    fanOutWidth: input.fanOutWidth,
    maxParallelNodes: input.maxParallelNodes,
    nodes: orderedNodes(input.nodes),
    running: [],
    shouldContinueAfterNodeResult: input.shouldContinueAfterNodeResult,
  };
}

function cancelledResult(
  state: ActiveSchedulerState
): WorkflowSchedulerRunResult {
  return { completed: state.completed, outcome: "CANCELLED" };
}

function terminalResult(
  state: ActiveSchedulerState,
  failure: RuntimeFailure | undefined
): WorkflowSchedulerRunResult {
  return {
    completed: state.completed,
    failure,
    outcome: failure ? "FAIL" : "PASS",
  };
}

function nodeErrorResult(
  state: ActiveSchedulerState,
  error: unknown
): WorkflowSchedulerRunResult {
  return {
    completed: state.completed,
    failure: workflowServiceFailure(error, "workflow.node"),
    outcome: "FAIL",
  };
}

// PIPE-83.10: the engine runs on Effect — each node is a forked fiber that
// reports its terminal outcome onto a completion queue. `Queue.take` replaces
// the hand-rolled `Promise.race`, and structured concurrency interrupts the
// in-flight fibers on cancellation or a node-level defect.
function runNodeFiber(
  ctx: SchedulerContext,
  nodeId: string
): Effect.Effect<void> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => ctx.input.runNode(nodeId),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Queue.offer(ctx.completions, { error, kind: "error" }),
      onSuccess: (result) =>
        Queue.offer(ctx.completions, { kind: "ok", result }),
    })
  );
}

function launchReady(ctx: SchedulerContext): Effect.Effect<void> {
  return Effect.gen(function* () {
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
}

function applyFailFastSkip(
  ctx: SchedulerContext,
  result: RuntimeNodeResult
): void {
  const reason = `skipped because workflow fail_fast stopped after node '${result.nodeId}' failed`;
  const skipped = unstartedNodeIds(ctx.state);
  ctx.state.blocked = uniqueStrings([...ctx.state.blocked, ...skipped]);
  for (const nodeId of skipped) {
    ctx.input.skipNode(nodeId, reason);
  }
}

// Fold one completed node into the run state (mutates ctx), mirroring the prior
// loop body: record it, then on a blocking failure either fail-fast-skip the
// rest or block its descendants.
function applyCompletion(
  ctx: SchedulerContext,
  result: RuntimeNodeResult
): void {
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
}

function applyOutcome(
  ctx: SchedulerContext,
  outcome: NodeOutcome
): Effect.Effect<WorkflowSchedulerRunResult | undefined> {
  return Effect.gen(function* () {
    if (outcome.kind === "error") {
      yield* Fiber.interruptAll(ctx.running.values());
      return nodeErrorResult(ctx.state, outcome.error);
    }
    applyCompletion(ctx, outcome.result);
    return;
  });
}

// One scheduler tick: stop if cancelled, launch newly-ready nodes within the
// caps, then either drain (no fibers left) or await the next completion.
function schedulerTick(
  ctx: SchedulerContext
): Effect.Effect<WorkflowSchedulerRunResult | undefined> {
  return Effect.gen(function* () {
    if (ctx.input.isCancelled()) {
      yield* Fiber.interruptAll(ctx.running.values());
      return cancelledResult(ctx.state);
    }
    yield* launchReady(ctx);
    if (ctx.running.size === 0) {
      return terminalResult(ctx.state, ctx.failure);
    }
    const outcome = yield* Queue.take(ctx.completions);
    return yield* applyOutcome(ctx, outcome);
  });
}

function schedulerProgram(
  input: WorkflowSchedulerInput
): Effect.Effect<WorkflowSchedulerRunResult> {
  return Effect.gen(function* () {
    const ctx: SchedulerContext = {
      completions: yield* Queue.unbounded<NodeOutcome>(),
      input,
      running: new Map<string, Fiber.Fiber<void>>(),
      state: initialSchedulerState(input),
    };
    while (true) {
      const done = yield* schedulerTick(ctx);
      if (done) {
        return done;
      }
    }
  });
}

export function runWorkflowScheduler(
  input: WorkflowSchedulerInput
): Promise<WorkflowSchedulerRunResult> {
  return Effect.runPromise(schedulerProgram(input));
}

// Nodes already completed or in flight — i.e. claimed, never re-launchable.
function settledNodeIds(
  context: Pick<WorkflowSchedulerState, "completed" | "running">
): Set<string> {
  const ids = new Set((context.completed ?? []).map((result) => result.nodeId));
  for (const nodeId of context.running) {
    ids.add(nodeId);
  }
  return ids;
}

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

export function computeReadyNodeIds(input: NodeReadinessInput): string[] {
  const completedIds = new Set((input.completed ?? []).map((r) => r.nodeId));
  const runningIds = new Set(input.running ?? []);
  const blockedIds = new Set(input.blocked ?? []);
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
}

function readyNodeIds(context: WorkflowSchedulerState): string[] {
  return computeReadyNodeIds(context);
}

function workflowNodeCapacity(context: WorkflowSchedulerState): number {
  const limit = context.failFast
    ? 1
    : (context.maxParallelNodes ?? context.nodes.length);
  return Math.max(0, limit - context.running.length);
}

function unstartedBlockingDescendants(
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

/**
 * Choose which ready nodes to launch this tick within the global capacity and
 * the per-category fan-out caps. A category at its cap defers its remaining
 * ready nodes to a later tick (it does not drop them). Nodes without a category
 * are bounded only by the global capacity. Without a fanOutWidth (e.g. in tests
 * or configs with no token_budget), this is the prior `slice(0, capacity)`.
 */
function selectLaunchableNodes(
  state: WorkflowSchedulerState,
  capacity: number
): string[] {
  const ready = readyNodeIds(state);
  return state.fanOutWidth
    ? cappedSelection(ready, capacity, state, state.fanOutWidth)
    : ready.slice(0, capacity);
}

function cappedSelection(
  ready: string[],
  capacity: number,
  state: WorkflowSchedulerState,
  fanOut: FanOutWidth
): string[] {
  const categoryOf = new Map(
    state.nodes.map((node) => [node.id, node.category])
  );
  const counts = categoryRunCounts(state.running, categoryOf);
  const selected: string[] = [];
  for (const nodeId of ready) {
    if (selected.length >= capacity) {
      break;
    }
    if (claimCategorySlot(categoryOf.get(nodeId), fanOut, counts)) {
      selected.push(nodeId);
    }
  }
  return selected;
}

function categoryCap(category: string, fanOut: FanOutWidth): number {
  return fanOut.by_category[category] ?? fanOut.default;
}

/**
 * Whether a node of the given category may launch now, consuming a slot from
 * `counts` when it can. Uncategorized nodes always may; a category at its cap
 * may not.
 */
function claimCategorySlot(
  category: string | undefined,
  fanOut: FanOutWidth,
  counts: Map<string, number>
): boolean {
  if (!category) {
    return true;
  }
  const current = counts.get(category) ?? 0;
  if (current >= categoryCap(category, fanOut)) {
    return false;
  }
  counts.set(category, current + 1);
  return true;
}

function categoryRunCounts(
  running: string[],
  categoryOf: Map<string, string | undefined>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const nodeId of running) {
    const category = categoryOf.get(nodeId);
    if (category) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return counts;
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
  const settled = settledNodeIds(context);
  return orderedNodes(context.nodes)
    .map((node) => node.id)
    .filter((nodeId) => !settled.has(nodeId));
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
