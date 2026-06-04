import { describe, expect, it } from "vitest";
import type { RuntimeNodeResult } from "../contracts";
import { parallelEvidence, parallelOutput } from "./parallel-node";

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
