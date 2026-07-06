import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import type { PlannedWorkflowNode } from "../planning/compile";
import type { ChangedFilesSnapshot, NodeExecutionState, RuntimeStructuredOutput } from "./contracts";
import { NodeStateStore } from "./node-state-store";

const pendingState = (id: string): NodeExecutionState => ({
  attempts: 0,
  evidence: [],
  gates: [],
  id,
  status: "pending",
});

const plannedNode = (id: string, index: number): PlannedWorkflowNode => ({
  dependents: [],
  id,
  index,
  kind: "agent",
  needs: [],
});

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
    expect(store.nodeSnapshots.get("a")?.files.has("src/example.ts")).toBe(true);
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

    const fork = parent.forkForParallelChildren([plannedNode("child-a", 0), plannedNode("child-b", 1)]);

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

  it("records and reads node handoffs keyed by node id", () => {
    const store = new NodeStateStore();
    store.recordHandoff("a", {
      artifacts: [],
      decisions: ["use Effect Schema"],
      openQuestions: [],
      summary: "did a thing",
      testNames: [],
    });

    expect(Option.getOrUndefined(store.handoff("a"))?.summary).toBe("did a thing");
    expect(Option.getOrUndefined(store.handoff("missing"))).toBeUndefined();
  });

  it("copies handoffByNode into parallel forks so children do not cross-contaminate", () => {
    const parent = new NodeStateStore();
    parent.recordHandoff("setup", {
      artifacts: [],
      decisions: [],
      openQuestions: [],
      summary: "setup",
      testNames: [],
    });

    const fork = parent.forkForParallelChildren([plannedNode("child-a", 0)]);

    // Unlike structuredOutputs (shared by reference), handoffs are copied.
    expect(fork.handoffByNode).not.toBe(parent.handoffByNode);
    expect(Option.getOrUndefined(fork.handoff("setup"))?.summary).toBe("setup");

    fork.recordHandoff("child-a", {
      artifacts: [],
      decisions: [],
      openQuestions: [],
      summary: "child",
      testNames: [],
    });

    expect(Option.getOrUndefined(parent.handoff("child-a"))).toBeUndefined();
  });
});
