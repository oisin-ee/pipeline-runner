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

interface RunningNode {
  nodeId: string;
  promise: Promise<RuntimeNodeResult>;
}

// PIPE-83.10: journal interactions are factored out so the durability seam adds
// no branches to the hot scheduler loop.
function resumeFromJournal(input: WorkflowSchedulerInput): RuntimeNodeResult[] {
  return input.journal?.resumeCompleted() ?? [];
}

function recordToJournal(
  input: WorkflowSchedulerInput,
  result: RuntimeNodeResult
): void {
  input.journal?.record(result);
}

export async function runWorkflowScheduler(
  input: WorkflowSchedulerInput
): Promise<WorkflowSchedulerRunResult> {
  const state: Required<Pick<WorkflowSchedulerState, "blocked" | "completed">> &
    Omit<WorkflowSchedulerState, "blocked" | "completed"> = {
    blocked: [],
    completed: resumeFromJournal(input),
    failFast: input.failFast,
    fanOutWidth: input.fanOutWidth,
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
    recordToJournal(input, result);

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

function readyNodeIds(context: WorkflowSchedulerState): string[] {
  const settled = settledNodeIds(context);
  const blocked = new Set(context.blocked ?? []);
  return orderedNodes(context.nodes)
    .filter((node) => !(settled.has(node.id) || blocked.has(node.id)))
    .filter((node) =>
      node.needs.every((need) => dependencyPassed(need, context))
    )
    .map((node) => node.id);
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

function launchReadyNodes(
  input: WorkflowSchedulerInput,
  state: WorkflowSchedulerState,
  running: Map<string, RunningNode>
): void {
  const capacity = workflowNodeCapacity(state);
  if (capacity <= 0) {
    return;
  }
  for (const nodeId of selectLaunchableNodes(state, capacity)) {
    input.markNodeReady(nodeId);
    state.running = [...state.running, nodeId];
    running.set(nodeId, { nodeId, promise: input.runNode(nodeId) });
  }
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
