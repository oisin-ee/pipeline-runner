import { describe, expect, it } from "vitest";
import type { PlannedWorkflowNode } from "../workflow-planner";
import type {
  ChangedFilesSnapshot,
  NodeExecutionState,
  RuntimeStructuredOutput,
} from "./contracts";
import { NodeStateStore } from "./node-state-store";

function pendingState(id: string): NodeExecutionState {
  return {
    attempts: 0,
    evidence: [],
    gates: [],
    id,
    status: "pending",
  };
}

describe("NodeStateStore", () => {
  it("owns mutable node state, snapshots, outputs, inherited output ids, and structured outputs", () => {
    const store = new NodeStateStore();
    const snapshot: ChangedFilesSnapshot = {
      files: new Set(["src/example.ts"]),
      fingerprints: new Map([["src/example.ts", "fingerprint"]]),
    };
    const structuredOutput: RuntimeStructuredOutput = {
      attempt: 1,
      format: "json",
      nodeId: "a",
      output: { ok: true },
      schemaPath: "$.result",
      validation: {
        evidence: [],
        passed: true,
        status: "valid",
      },
    };

    store.nodeStates.set("a", pendingState("a"));
    store.nodeSnapshots.set("a", snapshot);
    store.lastOutputByNode.set("setup", "setup output");
    store.inheritedOutputNodeIds.add("setup");
    store.structuredOutputs.push(structuredOutput);

    expect(store.nodeStates.get("a")).toMatchObject({
      attempts: 0,
      id: "a",
      status: "pending",
    });
    expect(store.nodeSnapshots.get("a")?.files.has("src/example.ts")).toBe(
      true
    );
    expect(store.lastOutputByNode.get("setup")).toBe("setup output");
    expect([...store.inheritedOutputNodeIds]).toEqual(["setup"]);
    expect(store.structuredOutputs).toEqual([structuredOutput]);
  });

  it("forks the existing runtime state for parallel children without mutating the parent store", () => {
    const parent = new NodeStateStore();
    parent.nodeStates.set("parent", {
      ...pendingState("parent"),
      status: "running",
    });
    parent.nodeSnapshots.set("parent", {
      files: new Set(["parent.ts"]),
      fingerprints: new Map([["parent.ts", "parent-fingerprint"]]),
    });
    parent.lastOutputByNode.set("setup", "setup output");
    parent.structuredOutputs.push({
      attempt: 1,
      format: "json",
      nodeId: "setup",
      output: { setup: true },
      schemaPath: "$.setup",
      validation: {
        evidence: [],
        passed: true,
        status: "valid",
      },
    });

    const fork = parent.forkForParallelChildren([
      { id: "child-a" } as PlannedWorkflowNode,
      { id: "child-b" } as PlannedWorkflowNode,
    ]);

    expect([...fork.inheritedOutputNodeIds]).toEqual(["setup"]);
    expect(fork.lastOutputByNode).not.toBe(parent.lastOutputByNode);
    expect(fork.lastOutputByNode.get("setup")).toBe("setup output");
    expect(fork.nodeSnapshots.size).toBe(0);
    expect([...fork.nodeStates.keys()]).toEqual(["child-a", "child-b"]);
    expect(fork.nodeStates.get("child-a")).toMatchObject({
      attempts: 0,
      id: "child-a",
      status: "pending",
    });
    expect(fork.structuredOutputs).toBe(parent.structuredOutputs);

    fork.lastOutputByNode.set("child-a", "child output");
    fork.nodeStates.set("child-c", pendingState("child-c"));

    expect(parent.lastOutputByNode.has("child-a")).toBe(false);
    expect(parent.nodeStates.has("child-c")).toBe(false);
    expect(parent.nodeSnapshots.has("parent")).toBe(true);
  });
});
