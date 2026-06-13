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

export interface GraphNode {
  id: string;
  needs?: string[];
}

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
