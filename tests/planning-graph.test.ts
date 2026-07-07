import { describe, expect, it } from "vitest";

import {
  createDependencyGraph,
  dependencyBatches,
  dependentsByNeed,
  descendantGraphValues,
  findDependencyCycles,
  findNode,
  flattenNodes,
  hasReachableDependent,
  terminalDependencyItems,
  topologicalDependencyOrder,
} from "../src/planning/graph";
import type { GraphNode } from "../src/planning/graph";

interface TestNode extends GraphNode {
  children?: TestNode[];
  id: string;
  kind?: string;
  needs?: string[];
}

const childrenOf = (node: TestNode) => node.children;

describe("flattenNodes", () => {
  it("returns flat nodes unchanged", () => {
    const nodes: TestNode[] = [{ id: "a" }, { id: "b" }];
    expect(flattenNodes(nodes, childrenOf).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("flattens nested parallel/workflow children depth-first, parents first", () => {
    const nodes: TestNode[] = [
      {
        children: [
          { id: "c1" },
          { children: [{ id: "c2" }, { id: "c3" }], id: "p2" },
        ],
        id: "p1",
      },
      { id: "tail" },
    ];
    expect(flattenNodes(nodes, childrenOf).map((n) => n.id)).toEqual([
      "p1",
      "c1",
      "p2",
      "c2",
      "c3",
      "tail",
    ]);
  });
});

describe("dependentsByNeed + hasReachableDependent", () => {
  it("indexes dependents and walks transitive downstream reachability", () => {
    const nodes: TestNode[] = [
      { id: "impl", kind: "agent" },
      { id: "mid", needs: ["impl"] },
      { id: "review", kind: "review", needs: ["mid"] },
    ];
    const index = dependentsByNeed(nodes);
    expect(index.get("impl")?.map((n) => n.id)).toEqual(["mid"]);

    expect(
      hasReachableDependent("impl", index, (n) => n.kind === "review")
    ).toBe(true);
    expect(
      hasReachableDependent("review", index, (n) => n.kind === "review")
    ).toBe(false);
  });

  it("is cycle-safe when dependents form a loop", () => {
    const nodes: TestNode[] = [
      { id: "a", needs: ["b"] },
      { id: "b", needs: ["a"] },
    ];
    const index = dependentsByNeed(nodes);
    expect(hasReachableDependent("a", index, (n) => n.id === "missing")).toBe(
      false
    );
  });
});

describe("findNode", () => {
  it("finds a node nested inside parallel children", () => {
    const nodes: TestNode[] = [
      { children: [{ children: [{ id: "leaf" }], id: "deep" }], id: "p" },
    ];
    expect(findNode(nodes, "leaf", childrenOf)?.id).toBe("leaf");
    expect(findNode(nodes, "absent", childrenOf)).toBeUndefined();
  });
});

describe("findDependencyCycles", () => {
  it("returns no cycles for an acyclic graph", () => {
    const nodes: TestNode[] = [
      { id: "a" },
      { id: "b", needs: ["a"] },
      { id: "c", needs: ["b"] },
    ];
    expect(findDependencyCycles(nodes)).toEqual([]);
  });

  it("detects a direct cycle once", () => {
    const nodes: TestNode[] = [
      { id: "a", needs: ["b"] },
      { id: "b", needs: ["a"] },
    ];
    const cycles = findDependencyCycles(nodes);
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0] ?? [])].toSorted()).toEqual(["a", "b"]);
  });

  it("detects a multi-node cycle and ignores undeclared needs", () => {
    const nodes: TestNode[] = [
      { id: "a", needs: ["c", "missing"] },
      { id: "b", needs: ["a"] },
      { id: "c", needs: ["b"] },
    ];
    const cycles = findDependencyCycles(nodes);
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0] ?? [])].toSorted()).toEqual(["a", "b", "c"]);
  });
});

describe("graphlib-backed DAG helpers", () => {
  it("builds dependency graphs and sequences stable topological batches", () => {
    const graph = createDependencyGraph(
      [
        { id: "root", needs: ["missing"] },
        { id: "right", needs: ["root"] },
        { id: "left", needs: ["root"] },
        { id: "join", needs: ["left", "right"] },
      ],
      {
        dependenciesOf: (node) => node.needs,
        valueOf: (node, index) => ({ ...node, index }),
      }
    );

    expect(graph.hasEdge("missing", "root")).toBe(false);
    expect(topologicalDependencyOrder(graph)).toEqual([
      "root",
      "left",
      "right",
      "join",
    ]);
    expect(
      dependencyBatches(graph, graph.nodes(), (left, right) => {
        const leftNode = graph.node(left);
        const rightNode = graph.node(right);
        return leftNode.index - rightNode.index;
      })
    ).toEqual([["root"], ["right", "left"], ["join"]]);
  });

  it("returns terminal items from dependency-key data", () => {
    const tasks = [
      { dependencies: [], taskName: "task-a" },
      { dependencies: ["task-a"], taskName: "task-b" },
      { dependencies: ["task-a"], taskName: "task-c" },
    ];

    expect(
      terminalDependencyItems(
        tasks,
        (task) => task.taskName,
        (task) => task.dependencies
      ).map((task) => task.taskName)
    ).toEqual(["task-b", "task-c"]);
  });

  it("walks descendant graph values from a root id", () => {
    const graph = createDependencyGraph(
      [
        { id: "PIPE-1" },
        { id: "PIPE-1.1", parentId: "PIPE-1" },
        { id: "PIPE-1.2", parentId: "PIPE-1" },
      ],
      {
        dependenciesOf: (node) =>
          node.parentId === undefined || node.parentId.length === 0
            ? []
            : [node.parentId],
        valueOf: (node) => node,
      }
    );

    expect(
      descendantGraphValues(graph, "PIPE-1").map((task) => task.id)
    ).toEqual(["PIPE-1.1", "PIPE-1.2"]);
  });
});
