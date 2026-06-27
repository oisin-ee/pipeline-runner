/*
 * Canonical, policy-free workflow graph traversal model (PIPE-48).
 *
 * Config validation, deterministic compile, and AI-schedule validation all need
 * the same structural operations over workflow node trees: flatten nested
 * containers, build a dependents-by-need index, walk downstream dependents, find
 * a node by id, and detect dependency cycles. This module owns ONLY those
 * structural operations. It is deliberately free of layer-specific policy:
 * callers pass their own `childrenOf`/`matches` predicates and own their error
 * vocabulary, so the shared model never becomes a dumping ground for one layer's
 * concerns (PIPE-48 AC#4).
 */

import { alg, Graph } from "@dagrejs/graphlib";

export interface GraphNode {
  id: string;
  needs?: string[];
}

export interface DependencyGraphInput {
  id: string;
}

export interface DependencyGraphBuildOptions<
  TInput extends DependencyGraphInput,
  TValue,
> {
  dependenciesOf: (node: TInput) => readonly string[] | undefined;
  valueOf: (node: TInput, index: number) => TValue;
}

export type DependencyGraph<TNode> = Graph<undefined, TNode>;

/**
 * Depth-first flatten of a node tree into a flat list (parents before
 * children), using the caller-supplied accessor to descend into nested
 * containers (e.g. parallel children). Nodes without children are returned
 * as-is.
 */
export function flattenNodes<TNode>(
  nodes: TNode[],
  childrenOf: (node: TNode) => TNode[] | undefined
): TNode[] {
  return nodes.flatMap((node) => {
    const children = childrenOf(node);
    return children && children.length > 0
      ? [node, ...flattenNodes(children, childrenOf)]
      : [node];
  });
}

/**
 * Build an index mapping each `need` id to the (flat) nodes that declare it as a
 * dependency. The input is expected to already be flattened by the caller so
 * that the resulting index spans the whole graph.
 */
export function dependentsByNeed<TNode extends GraphNode>(
  nodes: TNode[]
): Map<string, TNode[]> {
  const index = new Map<string, TNode[]>();
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      const dependents = index.get(need) ?? [];
      dependents.push(node);
      index.set(need, dependents);
    }
  }
  return index;
}

export function createDependencyGraph<
  TInput extends DependencyGraphInput,
  TValue,
>(
  nodes: readonly TInput[],
  options: DependencyGraphBuildOptions<TInput, TValue>
): DependencyGraph<TValue> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const graph = new Graph<undefined, TValue>({ directed: true });
  addDependencyGraphNodes(graph, nodes, options);
  addDependencyGraphEdges(graph, nodes, nodeIds, options);
  return graph;
}

function addDependencyGraphNodes<TInput extends DependencyGraphInput, TValue>(
  graph: DependencyGraph<TValue>,
  nodes: readonly TInput[],
  options: DependencyGraphBuildOptions<TInput, TValue>
): void {
  for (const [index, node] of nodes.entries()) {
    graph.setNode(node.id, options.valueOf(node, index));
  }
}

function addDependencyGraphEdges<TInput extends DependencyGraphInput, TValue>(
  graph: DependencyGraph<TValue>,
  nodes: readonly TInput[],
  nodeIds: ReadonlySet<string>,
  options: DependencyGraphBuildOptions<TInput, TValue>
): void {
  for (const node of nodes) {
    for (const dependencyId of declaredDependencyIds(node, nodeIds, options)) {
      graph.setEdge(dependencyId, node.id);
    }
  }
}

function declaredDependencyIds<TInput extends DependencyGraphInput, TValue>(
  node: TInput,
  nodeIds: ReadonlySet<string>,
  options: DependencyGraphBuildOptions<TInput, TValue>
): string[] {
  return [...(options.dependenciesOf(node) ?? [])].filter((dependencyId) =>
    nodeIds.has(dependencyId)
  );
}

export function dependencyPredecessorIds<TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): string[] {
  return graph.predecessors(nodeId) ?? [];
}

export function dependencyGraphNodeIds<TNode>(
  graph: DependencyGraph<TNode>
): string[] {
  return graph.nodes();
}

export function dependencyGraphHasNode<TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): boolean {
  return graph.hasNode(nodeId);
}

export function dependencyGraphValue<TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): TNode | undefined {
  if (!dependencyGraphHasNode(graph, nodeId)) {
    return;
  }
  return graph.node(nodeId);
}

export function successorIds<TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): string[] {
  return graph.successors(nodeId) ?? [];
}

export function graphEdgeIds<TNode>(
  graph: DependencyGraph<TNode>
): Array<{ from: string; to: string }> {
  return graph.edges().map((edge) => ({ from: edge.v, to: edge.w }));
}

export function descendantGraphValues<TNode>(
  graph: DependencyGraph<TNode>,
  rootId: string
): TNode[] {
  if (!graph.hasNode(rootId)) {
    return [];
  }
  return alg
    .preorder(graph, rootId)
    .slice(1)
    .map((id) => graph.node(id))
    .filter((node): node is TNode => Boolean(node));
}

export function dependencyCycleIds<TNode>(
  graph: DependencyGraph<TNode>
): string[][] {
  return alg.findCycles(graph);
}

export function topologicalDependencyOrder<TNode>(
  graph: DependencyGraph<TNode>
): string[] {
  /*
   * Keep @dagrejs/graphlib as the graph model, but do the topological sort
   * with this iterative traversal. graphlib's recursive topsort can hit call
   * stack overflow on deep generated workflow chains, while this preserves the
   * graphlib sink/predecessor ordering the planner tests cover.
   */
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const results: string[] = [];

  for (const sink of graph.sinks()) {
    visitForTopologicalOrder(sink, graph, visited, inStack, results);
  }

  if (visited.size !== graph.nodeCount()) {
    throw new Error("workflow graph contains a dependency cycle");
  }

  return results;
}

export function dependencyBatches<TNode>(
  graph: DependencyGraph<TNode>,
  nodeIds: readonly string[] = graph.nodes(),
  compareIds: (left: string, right: string) => number = compareStrings
): string[][] {
  const remaining = new Set(nodeIds);
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        dependencyPredecessorIds(graph, id).every(
          (dependencyId) => !remaining.has(dependencyId)
        )
      )
      .sort(compareIds);
    if (ready.length === 0) {
      return [];
    }
    batches.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
  }
  return batches;
}

export function terminalDependencyItems<TItem>(
  items: readonly TItem[],
  keyOf: (item: TItem) => string,
  dependenciesOf: (item: TItem) => readonly string[] | undefined
): TItem[] {
  const dependedOn = new Set(
    items.flatMap((item) => dependenciesOf(item) ?? [])
  );
  return items.filter((item) => !dependedOn.has(keyOf(item)));
}

/**
 * Breadth-first search over the dependents index to determine whether any node
 * transitively reachable downstream of `nodeId` satisfies `matches`. Cycle-safe
 * via a visited set.
 */
export function hasReachableDependent<TNode extends GraphNode>(
  nodeId: string,
  index: Map<string, TNode[]>,
  matches: (node: TNode) => boolean
): boolean {
  const visited = new Set<string>();
  const queue = [...(index.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || visited.has(node.id)) {
      continue;
    }
    visited.add(node.id);
    if (matches(node)) {
      return true;
    }
    queue.push(...(index.get(node.id) ?? []));
  }
  return false;
}

/**
 * Recursively find a node by id within a node tree, descending into children
 * via the caller-supplied accessor. Returns `undefined` when absent.
 */
export function findNode<TNode extends GraphNode>(
  nodes: TNode[],
  nodeId: string,
  childrenOf: (node: TNode) => TNode[] | undefined
): TNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node;
    }
    const child = findNode(childrenOf(node) ?? [], nodeId, childrenOf);
    if (child) {
      return child;
    }
  }
  return;
}

/**
 * Find all dependency cycles in a flat node list using an iterative DFS over the
 * dependents-by-need graph. Each cycle is returned once (canonicalized by its
 * member set) as the ordered list of node ids forming the loop. Only `needs`
 * that reference declared nodes participate, so callers can pass the full flat
 * node set without pre-filtering missing dependencies.
 *
 * The traversal is iterative (an explicit frame stack) rather than recursive so
 * that deep generated workflow chains cannot overflow the call stack.
 */
export function findDependencyCycles<TNode extends GraphNode>(
  nodes: TNode[]
): string[][] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const index = dependentsByNeed(nodes);
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(
      node.id,
      (index.get(node.id) ?? [])
        .map((dependent) => dependent.id)
        .filter((id) => nodeIds.has(id))
    );
  }

  const state = new Map<string, "done" | "visiting">();
  const path: string[] = [];
  const pathIndex = new Map<string, number>();
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();

  for (const node of nodes) {
    if (state.has(node.id)) {
      continue;
    }
    visitForCycles(node.id, {
      adjacency,
      cycleKeys,
      cycles,
      path,
      pathIndex,
      state,
    });
  }
  return cycles;
}

interface CycleVisitState {
  adjacency: Map<string, string[]>;
  cycleKeys: Set<string>;
  cycles: string[][];
  path: string[];
  pathIndex: Map<string, number>;
  state: Map<string, "done" | "visiting">;
}

interface TopologicalVisitFrame {
  index: number;
  nodeId: string;
  predecessors: string[];
}

function visitForCycles(startId: string, visitState: CycleVisitState): void {
  const frames: Array<{ index: number; nodeId: string }> = [
    { index: 0, nodeId: startId },
  ];
  markVisiting(startId, visitState);

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (!frame) {
      return;
    }
    const dependents = visitState.adjacency.get(frame.nodeId) ?? [];
    const dependentId = dependents[frame.index];
    if (!dependentId) {
      markDone(frame.nodeId, visitState);
      frames.pop();
      continue;
    }
    frame.index += 1;
    const dependentState = visitState.state.get(dependentId);
    if (dependentState === "visiting") {
      recordCycle(dependentId, visitState);
      continue;
    }
    if (dependentState === "done") {
      continue;
    }
    markVisiting(dependentId, visitState);
    frames.push({ index: 0, nodeId: dependentId });
  }
}

function markVisiting(nodeId: string, visitState: CycleVisitState): void {
  visitState.state.set(nodeId, "visiting");
  visitState.pathIndex.set(nodeId, visitState.path.length);
  visitState.path.push(nodeId);
}

function markDone(nodeId: string, visitState: CycleVisitState): void {
  visitState.state.set(nodeId, "done");
  visitState.pathIndex.delete(nodeId);
  visitState.path.pop();
}

function recordCycle(nodeId: string, visitState: CycleVisitState): void {
  const startIndex = visitState.pathIndex.get(nodeId);
  if (startIndex === undefined) {
    return;
  }
  const cycle = visitState.path.slice(startIndex);
  const key = [...cycle].sort().join("\0");
  if (visitState.cycleKeys.has(key)) {
    return;
  }
  visitState.cycleKeys.add(key);
  visitState.cycles.push(cycle);
}

function visitForTopologicalOrder<TNode>(
  startId: string,
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  results: string[]
): void {
  const frames: TopologicalVisitFrame[] = [];
  pushTopologicalFrame(startId, graph, visited, inStack, frames);

  while (frames.length > 0) {
    visitTopologicalFrame(graph, visited, inStack, results, frames);
  }
}

function visitTopologicalFrame<TNode>(
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  results: string[],
  frames: TopologicalVisitFrame[]
): void {
  const frame = frames.at(-1);
  if (!frame) {
    return;
  }
  const predecessorId = frame.predecessors[frame.index];
  if (!predecessorId) {
    completeTopologicalFrame(frame, inStack, results, frames);
    return;
  }
  frame.index += 1;
  visitTopologicalPredecessor(predecessorId, graph, visited, inStack, frames);
}

function completeTopologicalFrame(
  frame: TopologicalVisitFrame,
  inStack: Set<string>,
  results: string[],
  frames: TopologicalVisitFrame[]
): void {
  inStack.delete(frame.nodeId);
  results.push(frame.nodeId);
  frames.pop();
}

function visitTopologicalPredecessor<TNode>(
  predecessorId: string,
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  frames: TopologicalVisitFrame[]
): void {
  if (inStack.has(predecessorId)) {
    throw new Error("workflow graph contains a dependency cycle");
  }
  if (visited.has(predecessorId)) {
    return;
  }
  pushTopologicalFrame(predecessorId, graph, visited, inStack, frames);
}

function pushTopologicalFrame<TNode>(
  nodeId: string,
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  frames: TopologicalVisitFrame[]
): void {
  visited.add(nodeId);
  inStack.add(nodeId);
  frames.push({
    index: 0,
    nodeId,
    predecessors: dependencyPredecessorIds(graph, nodeId),
  });
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}
