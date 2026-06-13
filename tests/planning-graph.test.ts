import { describe, expect, it } from "vitest";
import {
  dependentsByNeed,
  findDependencyCycles,
  findNode,
  flattenNodes,
  type GraphNode,
  hasReachableDependent,
} from "../src/planning/graph";

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
        id: "p1",
        children: [
          { id: "c1" },
          { id: "p2", children: [{ id: "c2" }, { id: "c3" }] },
        ],
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
      { id: "p", children: [{ id: "deep", children: [{ id: "leaf" }] }] },
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
    expect([...(cycles[0] ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("detects a multi-node cycle and ignores undeclared needs", () => {
    const nodes: TestNode[] = [
      { id: "a", needs: ["c", "missing"] },
      { id: "b", needs: ["a"] },
      { id: "c", needs: ["b"] },
    ];
    const cycles = findDependencyCycles(nodes);
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0] ?? [])].sort()).toEqual(["a", "b", "c"]);
  });
});
