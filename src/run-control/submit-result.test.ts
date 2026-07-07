import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import type { RuntimeNodeResult } from "../runtime/contracts";
import { inMemoryDurableRunStore } from "../runtime/durable-store/durable-store";
import type { WorkflowScheduleNode } from "../runtime/scheduler";
import { buildNextNodeEnvelope } from "./next-node";
import type { NodeEnvelopeMetadata } from "./next-node";
import { recordSubmitResult } from "./submit-result";

const RUN_ID = "run-pipe91-test";

// Two-node graph: plan → implement (implement depends on plan).
const nodes: WorkflowScheduleNode[] = [
  { dependents: ["implement"], id: "plan", index: 0, needs: [] },
  { dependents: [], id: "implement", index: 1, needs: ["plan"] },
];

const nodeMetadata: ReadonlyMap<string, NodeEnvelopeMetadata> = new Map([
  [
    "plan",
    {
      criteria: [{ id: "ac1", text: "plan is done" }],
      prompt: "Plan the work",
    },
  ],
  [
    "implement",
    { criteria: [{ id: "ac2", text: "impl is done" }], prompt: "Implement" },
  ],
]);

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

const failedResult = (nodeId: string): RuntimeNodeResult => ({
  ...passedResult(nodeId),
  exitCode: 1,
  status: "failed",
});

describe("recordSubmitResult — AC1: next-node → submit-result → next-node round-trip", () => {
  it("first next-node returns plan; after submit, second returns implement", () => {
    const store = inMemoryDurableRunStore();
    const storeInput = { nodeMetadata, nodes, runId: RUN_ID, store };

    const first = buildNextNodeEnvelope(storeInput);
    expect(first?.nodeId).toBe("plan");

    recordSubmitResult({
      nodeId: "plan",
      resultJson: JSON.stringify(passedResult("plan")),
      runId: RUN_ID,
      store,
    });

    const second = buildNextNodeEnvelope(storeInput);
    expect(second?.nodeId).toBe("implement");
  });

  it("implement envelope carries plan's output as upstreamOutputs", () => {
    const store = inMemoryDurableRunStore();

    recordSubmitResult({
      nodeId: "plan",
      resultJson: JSON.stringify(passedResult("plan")),
      runId: RUN_ID,
      store,
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });
    expect(envelope?.upstreamOutputs).toEqual([
      { nodeId: "plan", output: "output of plan" },
    ]);
  });

  it("no ready nodes once all nodes submitted as passed — run complete", () => {
    const store = inMemoryDurableRunStore();

    recordSubmitResult({
      nodeId: "plan",
      resultJson: JSON.stringify(passedResult("plan")),
      runId: RUN_ID,
      store,
    });
    recordSubmitResult({
      nodeId: "implement",
      resultJson: JSON.stringify(passedResult("implement")),
      runId: RUN_ID,
      store,
    });

    expect(
      buildNextNodeEnvelope({ nodeMetadata, nodes, runId: RUN_ID, store })
    ).toBeUndefined();
  });

  it("a failed plan node is settled — implement is not emitted (blocked by failed dep)", () => {
    const store = inMemoryDurableRunStore();

    recordSubmitResult({
      nodeId: "plan",
      resultJson: JSON.stringify(failedResult("plan")),
      runId: RUN_ID,
      store,
    });

    // plan is settled (failed), implement is blocked; no ready nodes
    expect(
      buildNextNodeEnvelope({ nodeMetadata, nodes, runId: RUN_ID, store })
    ).toBeUndefined();
  });
});

describe("recordSubmitResult — AC2: malformed or mismatched submit rejected; store unchanged", () => {
  it("rejects a RuntimeNodeResult missing required fields with Effect Schema error", () => {
    const store = inMemoryDurableRunStore();
    // Missing attempts, evidence, exitCode
    const malformed = JSON.stringify({
      nodeId: "plan",
      output: "done",
      status: "passed",
    });

    expect(() => {
      recordSubmitResult({
        nodeId: "plan",
        resultJson: malformed,
        runId: RUN_ID,
        store,
      });
    }).toThrow(/attempts|evidence|exitCode/u);

    expect(Option.isNone(store.get(RUN_ID, "plan"))).toBe(true);
  });

  it("rejects a result.nodeId ≠ nodeId mismatch with Effect Schema error", () => {
    const store = inMemoryDurableRunStore();
    // result.nodeId is "implement" but we're submitting under "plan"
    const mismatch = JSON.stringify(passedResult("implement"));

    expect(() => {
      recordSubmitResult({
        nodeId: "plan",
        resultJson: mismatch,
        runId: RUN_ID,
        store,
      });
    }).toThrow(/result\.nodeId/u);

    expect(Option.isNone(store.get(RUN_ID, "plan"))).toBe(true);
  });

  it("rejects invalid JSON with a SyntaxError", () => {
    const store = inMemoryDurableRunStore();

    expect(() => {
      recordSubmitResult({
        nodeId: "plan",
        resultJson: "{not-json}",
        runId: RUN_ID,
        store,
      });
    }).toThrow(SyntaxError);

    expect(Option.isNone(store.get(RUN_ID, "plan"))).toBe(true);
  });
});
