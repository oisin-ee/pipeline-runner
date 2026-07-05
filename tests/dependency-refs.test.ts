import { describe, expect, it } from "vitest";

import type { PlannedWorkflowNode } from "../src/planning/compile";
import {
  indexPlannedNodesById,
  resolveExecutableDependencyIds,
} from "../src/planning/dependency-refs";

const node = (
  id: string,
  kind: PlannedWorkflowNode["kind"],
  extra: Partial<PlannedWorkflowNode> = {}
): PlannedWorkflowNode => ({
  dependents: [],
  id,
  index: 0,
  kind,
  needs: [],
  ...extra,
});

const mechanicalChecks = node("mechanical-checks", "parallel", {
  children: [
    node("mechanical-tests", "builtin", { builtin: "test" }),
    node("mechanical-typecheck", "builtin", { builtin: "typecheck" }),
    node("mechanical-lint", "builtin", { builtin: "lint" }),
    node("mechanical-fallow", "builtin", { builtin: "fallow" }),
  ],
  needs: ["green-cross-platform-ui"],
});

const plan: PlannedWorkflowNode[] = [
  node("green-cross-platform-ui", "agent", { needs: ["red-tests"] }),
  mechanicalChecks,
  node("verification", "agent", { needs: ["mechanical-checks"] }),
];

describe("resolveExecutableDependencyIds", () => {
  it("resolves an executable dependency to itself", () => {
    const byId = indexPlannedNodesById(plan);
    expect(
      resolveExecutableDependencyIds(byId, ["green-cross-platform-ui"])
    ).toEqual(["green-cross-platform-ui"]);
  });

  it("expands a parallel container to its executable leaf children", () => {
    const byId = indexPlannedNodesById(plan);
    // The bug: review nodes needed `mechanical-checks` (a parallel container that
    // pushes no branch) and fetched a non-existent nodes/mechanical-checks ref.
    expect(resolveExecutableDependencyIds(byId, ["mechanical-checks"])).toEqual(
      [
        "mechanical-tests",
        "mechanical-typecheck",
        "mechanical-lint",
        "mechanical-fallow",
      ]
    );
  });

  it("recurses through nested parallel containers to the leaves", () => {
    const nested = [
      node("outer", "parallel", {
        children: [
          node("inner", "parallel", {
            children: [node("leaf-a", "builtin", { builtin: "test" })],
          }),
          node("leaf-b", "agent"),
        ],
      }),
    ];
    const byId = indexPlannedNodesById(nested);
    expect(resolveExecutableDependencyIds(byId, ["outer"])).toEqual([
      "leaf-a",
      "leaf-b",
    ]);
  });

  it("dedupes and resolves mixed container + executable needs", () => {
    const byId = indexPlannedNodesById(plan);
    expect(
      resolveExecutableDependencyIds(byId, [
        "mechanical-checks",
        "green-cross-platform-ui",
        "mechanical-checks",
      ])
    ).toEqual([
      "mechanical-tests",
      "mechanical-typecheck",
      "mechanical-lint",
      "mechanical-fallow",
      "green-cross-platform-ui",
    ]);
  });

  it("drops unknown dependency ids", () => {
    const byId = indexPlannedNodesById(plan);
    expect(resolveExecutableDependencyIds(byId, ["does-not-exist"])).toEqual(
      []
    );
  });
});
