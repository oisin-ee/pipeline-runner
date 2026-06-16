import { describe, expect, it } from "vitest";
import type { RuntimeNodeResult } from "../contracts";
import {
  childCategory,
  parallelEvidence,
  parallelOutput,
} from "./parallel-node";

describe("childCategory", () => {
  const fanOut = { by_category: { green: 2, verification: 1 }, default: 4 };

  it("returns the matching category whose name the child id includes", () => {
    expect(childCategory("green-implementation--c1", fanOut)).toBe("green");
    expect(childCategory("verification", fanOut)).toBe("verification");
  });

  it("returns undefined when no category matches or fan-out is absent", () => {
    expect(childCategory("intake", fanOut)).toBeUndefined();
    expect(childCategory("green-x", undefined)).toBeUndefined();
  });
});

describe("runtime parallel node", () => {
  it("reports successful child completion", () => {
    const results: RuntimeNodeResult[] = [
      {
        attempts: 1,
        evidence: ["left passed"],
        exitCode: 0,
        nodeId: "left",
        output: "L",
        status: "passed",
      },
    ];

    expect(parallelEvidence("fanout", results, [])).toEqual([
      "parallel node 'fanout' completed 1 child nodes",
    ]);
  });

  it("serializes child outputs in declaration order", () => {
    const output = parallelOutput(
      [
        {
          children: [],
          dependents: [],
          id: "left",
          index: 0,
          kind: "command",
          command: ["left"],
          needs: [],
        },
        {
          children: [],
          dependents: [],
          id: "right",
          index: 1,
          kind: "command",
          command: ["right"],
          needs: [],
        },
      ],
      [
        {
          attempts: 1,
          evidence: [],
          exitCode: 0,
          nodeId: "right",
          output: "R",
          status: "passed",
        },
        {
          attempts: 1,
          evidence: [],
          exitCode: 0,
          nodeId: "left",
          output: "L",
          status: "passed",
        },
      ]
    );

    expect(JSON.parse(output)).toEqual({
      children: { left: "L", right: "R" },
    });
  });
});
