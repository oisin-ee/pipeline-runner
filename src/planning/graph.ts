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
import * as Option from "effect/Option";

export interface GraphNode {
  id: string;
  needs?: string[];
}

export interface DependencyGraphInput {
  id: string;
}

interface OptionalDependencyIds {
  readonly needs?: readonly string[];
}

interface OptionalNodeChildren<TNode> {
  readonly children?: TNode[];
}

type OptionalDependencyIdList = OptionalDependencyIds["needs"];
type OptionalNodeList<TNode> = OptionalNodeChildren<TNode>["children"];

export interface DependencyGraphBuildOptions<
  TInput extends DependencyGraphInput,
  TValue,
> {
  dependenciesOf: (node: TInput) => OptionalDependencyIdList;
  valueOf: (node: TInput, index: number) => TValue;
}

export type DependencyGraph<TNode> = Graph<undefined, TNode>;

/**
 * Depth-first flatten of a node tree into a flat list (parents before
 * children), using the caller-supplied accessor to descend into nested
 * containers (e.g. parallel children). Nodes without children are returned
 * as-is.
 */
export const flattenNodes = <TNode>(
  nodes: TNode[],
  childrenOf: (node: TNode) => OptionalNodeList<TNode>
): TNode[] =>
  nodes.flatMap((node) => {
    const children = Option.fromUndefinedOr(childrenOf(node));
    return Option.match(children, {
      onNone: () => [node],
      onSome: (value) =>
        value.length > 0 ? [node, ...flattenNodes(value, childrenOf)] : [node],
    });
  });

/**
 * Build an index mapping each `need` id to the (flat) nodes that declare it as a
 * dependency. The input is expected to already be flattened by the caller so
 * that the resulting index spans the whole graph.
 */
export const dependentsByNeed = <TNode extends GraphNode>(
  nodes: TNode[]
): Map<string, TNode[]> => {
  const index = new Map<string, TNode[]>();
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      const dependents = index.get(need) ?? [];
      dependents.push(node);
      index.set(need, dependents);
    }
  }
  return index;
};

const addDependencyGraphNodes = <TInput extends DependencyGraphInput, TValue>(
  graph: DependencyGraph<TValue>,
  nodes: readonly TInput[],
  options: DependencyGraphBuildOptions<TInput, TValue>
): void => {
  for (const [index, node] of nodes.entries()) {
    graph.setNode(node.id, options.valueOf(node, index));
  }
};

const declaredDependencyIds = <TInput extends DependencyGraphInput, TValue>(
  node: TInput,
  nodeIds: ReadonlySet<string>,
  options: DependencyGraphBuildOptions<TInput, TValue>
): string[] =>
  [...(options.dependenciesOf(node) ?? [])].filter((dependencyId) =>
    nodeIds.has(dependencyId)
  );

const addDependencyGraphEdges = <TInput extends DependencyGraphInput, TValue>(
  graph: DependencyGraph<TValue>,
  nodes: readonly TInput[],
  nodeIds: ReadonlySet<string>,
  options: DependencyGraphBuildOptions<TInput, TValue>
): void => {
  for (const node of nodes) {
    for (const dependencyId of declaredDependencyIds(node, nodeIds, options)) {
      graph.setEdge(dependencyId, node.id);
    }
  }
};

export const createDependencyGraph = <
  TInput extends DependencyGraphInput,
  TValue,
>(
  nodes: readonly TInput[],
  options: DependencyGraphBuildOptions<TInput, TValue>
): DependencyGraph<TValue> => {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const graph = new Graph<undefined, TValue>({ directed: true });
  addDependencyGraphNodes(graph, nodes, options);
  addDependencyGraphEdges(graph, nodes, nodeIds, options);
  return graph;
};

export const dependencyPredecessorIds = <TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): string[] => graph.predecessors(nodeId) ?? [];

export const dependencyGraphNodeIds = <TNode>(
  graph: DependencyGraph<TNode>
): string[] => graph.nodes();

export const dependencyGraphHasNode = <TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): boolean => graph.hasNode(nodeId);

export const dependencyGraphValue = <TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): ReturnType<typeof Option.getOrUndefined<TNode>> => {
  if (!dependencyGraphHasNode(graph, nodeId)) {
    return Option.getOrUndefined(Option.none());
  }
  return Option.getOrUndefined(Option.fromUndefinedOr(graph.node(nodeId)));
};

export const successorIds = <TNode>(
  graph: DependencyGraph<TNode>,
  nodeId: string
): string[] => graph.successors(nodeId) ?? [];

export const graphEdgeIds = <TNode>(
  graph: DependencyGraph<TNode>
): { from: string; to: string }[] =>
  graph.edges().map((edge) => ({ from: edge.v, to: edge.w }));

export const descendantGraphValues = <TNode>(
  graph: DependencyGraph<TNode>,
  rootId: string
): TNode[] => {
  if (!graph.hasNode(rootId)) {
    return [];
  }
  return alg
    .preorder(graph, rootId)
    .slice(1)
    .map((id) => graph.node(id))
    .filter((node): node is TNode => node !== undefined);
};

export const dependencyCycleIds = <TNode>(
  graph: DependencyGraph<TNode>
): string[][] => alg.findCycles(graph);

export const terminalDependencyItems = <TItem>(
  items: readonly TItem[],
  keyOf: (item: TItem) => string,
  dependenciesOf: (item: TItem) => OptionalDependencyIdList
): TItem[] => {
  const dependedOn = new Set(
    items.flatMap((item) => dependenciesOf(item) ?? [])
  );
  return items.filter((item) => !dependedOn.has(keyOf(item)));
};

/**
 * Breadth-first search over the dependents index to determine whether any node
 * transitively reachable downstream of `nodeId` satisfies `matches`. Cycle-safe
 * via a visited set.
 */
export const hasReachableDependent = <TNode extends GraphNode>(
  nodeId: string,
  index: Map<string, TNode[]>,
  matches: (node: TNode) => boolean
): boolean => {
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
};

const findNodeOption = <TNode extends GraphNode>(
  nodes: TNode[],
  nodeId: string,
  childrenOf: (node: TNode) => OptionalNodeList<TNode>
): Option.Option<TNode> => {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return Option.some(node);
    }
    const child = findNodeOption(
      Option.getOrElse(Option.fromUndefinedOr(childrenOf(node)), () => []),
      nodeId,
      childrenOf
    );
    if (Option.isSome(child)) {
      return child;
    }
  }
  return Option.none();
};

/**
 * Recursively find a node by id within a node tree, descending into children
 * via the caller-supplied accessor. Returns `undefined` when absent.
 */
export const findNode = <TNode extends GraphNode>(
  nodes: TNode[],
  nodeId: string,
  childrenOf: (node: TNode) => OptionalNodeList<TNode>
): ReturnType<typeof Option.getOrUndefined<TNode>> =>
  Option.getOrUndefined(findNodeOption(nodes, nodeId, childrenOf));

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

const markVisiting = (nodeId: string, visitState: CycleVisitState): void => {
  visitState.state.set(nodeId, "visiting");
  visitState.pathIndex.set(nodeId, visitState.path.length);
  visitState.path.push(nodeId);
};

const markDone = (nodeId: string, visitState: CycleVisitState): void => {
  visitState.state.set(nodeId, "done");
  visitState.pathIndex.delete(nodeId);
  visitState.path.pop();
};

const recordCycle = (nodeId: string, visitState: CycleVisitState): void => {
  const startIndex = visitState.pathIndex.get(nodeId);
  if (startIndex === undefined) {
    return;
  }
  const cycle = visitState.path.slice(startIndex);
  const key = [...cycle].toSorted().join("\0");
  if (visitState.cycleKeys.has(key)) {
    return;
  }
  visitState.cycleKeys.add(key);
  visitState.cycles.push(cycle);
};

const visitForCycles = (startId: string, visitState: CycleVisitState): void => {
  const frames: { index: number; nodeId: string }[] = [
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
};

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
export const findDependencyCycles = (nodes: GraphNode[]): string[][] => {
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
};

const completeTopologicalFrame = (
  frame: TopologicalVisitFrame,
  inStack: Set<string>,
  results: string[],
  frames: TopologicalVisitFrame[]
): void => {
  inStack.delete(frame.nodeId);
  results.push(frame.nodeId);
  frames.pop();
};

const pushTopologicalFrame = <TNode>(
  nodeId: string,
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  frames: TopologicalVisitFrame[]
): void => {
  visited.add(nodeId);
  inStack.add(nodeId);
  frames.push({
    index: 0,
    nodeId,
    predecessors: dependencyPredecessorIds(graph, nodeId),
  });
};

const visitTopologicalPredecessor = <TNode>(
  predecessorId: string,
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  frames: TopologicalVisitFrame[]
): void => {
  if (inStack.has(predecessorId)) {
    throw new Error("workflow graph contains a dependency cycle");
  }
  if (visited.has(predecessorId)) {
    return;
  }
  pushTopologicalFrame(predecessorId, graph, visited, inStack, frames);
};

const visitTopologicalFrame = <TNode>(
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  results: string[],
  frames: TopologicalVisitFrame[]
): void => {
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
};

const visitForTopologicalOrder = <TNode>(
  startId: string,
  graph: DependencyGraph<TNode>,
  visited: Set<string>,
  inStack: Set<string>,
  results: string[]
): void => {
  const frames: TopologicalVisitFrame[] = [];
  pushTopologicalFrame(startId, graph, visited, inStack, frames);

  while (frames.length > 0) {
    visitTopologicalFrame(graph, visited, inStack, results, frames);
  }
};

export const topologicalDependencyOrder = <TNode>(
  graph: DependencyGraph<TNode>
): string[] => {
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
};

const compareStrings = (left: string, right: string): number =>
  left.localeCompare(right);

export const dependencyBatches = <TNode>(
  graph: DependencyGraph<TNode>,
  nodeIds: readonly string[] = graph.nodes(),
  compareIds: (left: string, right: string) => number = compareStrings
): string[][] => {
  const remaining = new Set(nodeIds);
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        dependencyPredecessorIds(graph, id).every(
          (dependencyId) => !remaining.has(dependencyId)
        )
      )
      .toSorted(compareIds);
    if (ready.length === 0) {
      return [];
    }
    batches.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
  }
  return batches;
};
