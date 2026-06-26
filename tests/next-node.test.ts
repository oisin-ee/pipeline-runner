import { describe, expect, it } from "vitest";
import { buildNextNodeEnvelope } from "../src/run-control/next-node";
import type { AcceptanceCriterion } from "../src/runtime/contracts/contracts";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import type { WorkflowScheduleNode } from "../src/runtime/scheduler";
import { computeReadyNodeIds } from "../src/runtime/scheduler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(
  id: string,
  index: number,
  needs: string[] = [],
  dependents: string[] = []
): WorkflowScheduleNode {
  return { dependents, id, index, needs };
}

function passedResult(nodeId: string, output = `output-of-${nodeId}`) {
  return {
    attempts: 1,
    evidence: [],
    exitCode: 0,
    nodeId,
    output,
    status: "passed" as const,
  };
}

// ---------------------------------------------------------------------------
// computeReadyNodeIds (pure unit tests)
// ---------------------------------------------------------------------------

describe("computeReadyNodeIds", () => {
  it("returns all root nodes when nothing has completed", () => {
    const nodes = [node("a", 0), node("b", 1)];
    expect(computeReadyNodeIds({ nodes })).toEqual(["a", "b"]);
  });

  it("unlocks a dependent once its need has passed", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [passedResult("a")];
    expect(computeReadyNodeIds({ completed, nodes })).toEqual(["b"]);
  });

  it("does not make a dependent ready when its need failed and no override", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [
      { ...passedResult("a"), exitCode: 1, status: "failed" as const },
    ];
    expect(computeReadyNodeIds({ completed, nodes })).toEqual([]);
  });

  it("uses shouldContinueAfterNodeResult to override the default failure-blocking", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [
      { ...passedResult("a"), exitCode: 1, status: "failed" as const },
    ];
    // Treat all results as continuing — even failures unblock dependents.
    expect(
      computeReadyNodeIds({
        completed,
        nodes,
        shouldContinueAfterNodeResult: () => true,
      })
    ).toEqual(["b"]);
  });

  it("excludes already-running nodes from the ready list", () => {
    const nodes = [node("a", 0), node("b", 1)];
    expect(computeReadyNodeIds({ nodes, running: ["a"] })).toEqual(["b"]);
  });

  it("excludes blocked nodes", () => {
    const nodes = [node("a", 0), node("b", 1)];
    expect(computeReadyNodeIds({ blocked: ["b"], nodes })).toEqual(["a"]);
  });

  it("returns empty when all nodes are completed", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [passedResult("a"), passedResult("b")];
    expect(computeReadyNodeIds({ completed, nodes })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildNextNodeEnvelope (integration — in-memory store seeded with real data)
// ---------------------------------------------------------------------------

describe("buildNextNodeEnvelope", () => {
  const RUN_ID = "test-run-001";

  const criteria: AcceptanceCriterion[] = [
    { id: "ac-1", text: "Output contains the word hello" },
  ];

  const nodes = [node("setup", 0), node("work", 1, ["setup"])];

  const nodeMetadata = new Map([
    ["setup", { criteria: [], prompt: "Run the setup script" }],
    ["work", { criteria, prompt: "Do the main work" }],
  ]);

  it("emits the envelope for the first ready node (setup) with an empty store", () => {
    const store = inMemoryDurableRunStore();
    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });

    expect(envelope).toEqual({
      criteria: [],
      nodeId: "setup",
      prompt: "Run the setup script",
      runId: RUN_ID,
      upstreamOutputs: [],
    });
  });

  it("advances to the next ready node after upstream completes", () => {
    const store = inMemoryDurableRunStore();
    const setupResult = passedResult("setup", "setup completed ok");
    store.record(RUN_ID, "setup", {
      criteria: [],
      inputs: undefined,
      result: { ...setupResult },
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });

    expect(envelope?.nodeId).toBe("work");
    expect(envelope?.prompt).toBe("Do the main work");
    expect(envelope?.criteria).toEqual(criteria);
    expect(envelope?.upstreamOutputs).toEqual([
      { nodeId: "setup", output: "setup completed ok" },
    ]);
    expect(envelope?.runId).toBe(RUN_ID);
  });

  it("returns undefined when all nodes have passed (run complete)", () => {
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "setup", {
      criteria: [],
      inputs: undefined,
      result: passedResult("setup"),
    });
    store.record(RUN_ID, "work", {
      criteria,
      inputs: undefined,
      result: passedResult("work"),
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });
    expect(envelope).toBeUndefined();
  });

  it("returns undefined when the remaining node is blocked by an upstream failure", () => {
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "setup", {
      criteria: [],
      inputs: undefined,
      result: { ...passedResult("setup"), exitCode: 1, status: "failed" },
    });

    // "work" needs "setup" which failed — no shouldContinueAfterNodeResult override,
    // so "work" is not ready.
    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });
    expect(envelope).toBeUndefined();
  });

  it("includes upstream outputs only for direct needs, not transitive ancestors", () => {
    const threeNodes = [node("a", 0), node("b", 1, ["a"]), node("c", 2, ["b"])];
    const meta = new Map([
      ["a", { criteria: [], prompt: "step a" }],
      ["b", { criteria: [], prompt: "step b" }],
      ["c", { criteria: [], prompt: "step c" }],
    ]);
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "a", {
      criteria: [],
      inputs: undefined,
      result: passedResult("a", "a-output"),
    });
    store.record(RUN_ID, "b", {
      criteria: [],
      inputs: undefined,
      result: passedResult("b", "b-output"),
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata: meta,
      nodes: threeNodes,
      runId: RUN_ID,
      store,
    });

    expect(envelope?.nodeId).toBe("c");
    // "c" directly needs "b" only — "a" is a transitive ancestor and excluded.
    expect(envelope?.upstreamOutputs).toEqual([
      { nodeId: "b", output: "b-output" },
    ]);
  });
});
