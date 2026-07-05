import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { buildNextNodeEnvelope } from "../src/run-control/next-node";
import type { RuntimeNodeResult } from "../src/runtime/contracts/contracts";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import type { NextNodeEnvelope } from "../src/runtime/node-protocol/node-protocol";
import type { WorkflowScheduleNode } from "../src/runtime/scheduler";
import {
  buildEnvelopeForNode,
  recordNodeResult,
  stepNode,
  stepRun,
} from "../src/runtime/step/step-node";
import type { StepNodeDeps } from "../src/runtime/step/step-node";

const RUN_ID = "step-run-001";
const MISSING_NODE_RE = /ghost/u;

// Two-node graph: plan → implement (implement depends on plan).
const nodes: WorkflowScheduleNode[] = [
  { dependents: ["implement"], id: "plan", index: 0, needs: [] },
  { dependents: [], id: "implement", index: 1, needs: ["plan"] },
];

const nodeMetadata = new Map([
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

const passedResult = (
  nodeId: string,
  output = `output of ${nodeId}`
): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output,
  status: "passed",
});

// A fake executor that records which envelopes it saw and returns a passed
// result for each. Stands in for the local/Argo node executors.
const recordingExecutor = () => {
  const seen: NextNodeEnvelope[] = [];
  const executeNode = async (
    envelope: NextNodeEnvelope
  ): Promise<RuntimeNodeResult> => {
    seen.push(envelope);
    return passedResult(envelope.nodeId);
  };
  return { executeNode, seen };
};

describe("buildEnvelopeForNode", () => {
  it("builds the envelope for a specific given node, folding in passed upstream outputs", () => {
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "plan", {
      criteria: [],
      inputs: undefined,
      result: passedResult("plan", "plan output"),
    });

    const envelope = buildEnvelopeForNode(
      { nodeMetadata, nodes, runId: RUN_ID, store },
      "implement"
    );

    expect(envelope).toEqual({
      criteria: [{ id: "ac2", text: "impl is done" }],
      nodeId: "implement",
      prompt: "Implement",
      runId: RUN_ID,
      upstreamOutputs: [{ nodeId: "plan", output: "plan output" }],
    });
  });

  it("returns undefined for a node id absent from the graph", () => {
    const store = inMemoryDurableRunStore();
    expect(
      buildEnvelopeForNode(
        { nodeMetadata, nodes, runId: RUN_ID, store },
        "ghost"
      )
    ).toBeUndefined();
  });
});

describe("toRunJournal record path — PIPE-94.7: one record owner", () => {
  it("records a local-run result through the same path recordNodeResult writes, retrievable via store.get", () => {
    const result = passedResult("plan", "via journal");

    // Local-run path: the scheduler records terminal results through the
    // journal adapter (WorkflowSchedulerInput.journal = store.toRunJournal).
    const viaJournalStore = inMemoryDurableRunStore();
    viaJournalStore.toRunJournal(RUN_ID).record(result);

    // Step-node core path: recordNodeResult writes the canonical record shape.
    const viaCoreStore = inMemoryDurableRunStore();
    recordNodeResult({ result, runId: RUN_ID, store: viaCoreStore });

    const viaJournal = viaJournalStore.get(RUN_ID, "plan");
    const viaCore = viaCoreStore.get(RUN_ID, "plan");
    const viaJournalRecord = Option.getOrThrow(viaJournal);
    const viaCoreRecord = Option.getOrThrow(viaCore);
    expect(viaJournalRecord.criteria).toEqual(viaCoreRecord.criteria);
    expect(viaJournalRecord.inputs).toEqual(viaCoreRecord.inputs);
    expect(viaJournalRecord.result).toEqual(viaCoreRecord.result);
    expect(viaJournalRecord.result).toEqual(result);
  });
});

describe("stepNode — AC1: build → execute (injected) → record", () => {
  it("records the executor's result and passes the built envelope to the executor", async () => {
    const store = inMemoryDurableRunStore();
    const executor = recordingExecutor();
    const deps: StepNodeDeps = {
      executeNode: executor.executeNode,
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    };

    const result = await Effect.runPromise(stepNode(deps, "plan"));

    expect(result).toEqual(passedResult("plan"));
    // The result is persisted under (runId, nodeId).
    expect(Option.getOrThrow(store.get(RUN_ID, "plan")).result).toEqual(
      passedResult("plan")
    );
    // The executor received the envelope built for that node.
    expect(executor.seen).toHaveLength(1);
    expect(executor.seen[0]?.nodeId).toBe("plan");
    expect(executor.seen[0]?.prompt).toBe("Plan the work");
  });

  it("after stepNode, buildNextNodeEnvelope advances to the dependent", async () => {
    const store = inMemoryDurableRunStore();
    const executor = recordingExecutor();
    const deps: StepNodeDeps = {
      executeNode: executor.executeNode,
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    };

    await Effect.runPromise(stepNode(deps, "plan"));

    const next = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });
    expect(next?.nodeId).toBe("implement");
    expect(next?.upstreamOutputs).toEqual([
      { nodeId: "plan", output: "output of plan" },
    ]);
  });

  it("fails when the given node id is absent from the graph", async () => {
    const store = inMemoryDurableRunStore();
    const executor = recordingExecutor();
    const deps: StepNodeDeps = {
      executeNode: executor.executeNode,
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    };

    await expect(Effect.runPromise(stepNode(deps, "ghost"))).rejects.toThrow(
      MISSING_NODE_RE
    );
    expect(executor.seen).toHaveLength(0);
  });
});

describe("stepRun — selection + execution loop", () => {
  it("drives every ready node to completion in dependency order", async () => {
    const store = inMemoryDurableRunStore();
    const executor = recordingExecutor();
    const deps: StepNodeDeps = {
      executeNode: executor.executeNode,
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    };

    const results = await Effect.runPromise(stepRun(deps));

    expect(results.map((r) => r.nodeId)).toEqual(["plan", "implement"]);
    expect(executor.seen.map((e) => e.nodeId)).toEqual(["plan", "implement"]);
    // No nodes left ready once the run is drained.
    expect(
      buildNextNodeEnvelope({ nodeMetadata, nodes, runId: RUN_ID, store })
    ).toBeUndefined();
  });
});
