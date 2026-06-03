import { describe, expect, it } from "vitest";
import {
  gateStateNames,
  hookStateNames,
  nodeStateNames,
  runtimeActorId,
  runtimeMachineTags,
  workflowStateNames,
} from "../src/runtime-machines/contracts.js";

describe("runtime machine contracts", () => {
  it("exports the explicit runtime state and tag taxonomy", () => {
    expect(nodeStateNames).toEqual(
      expect.arrayContaining([
        "pending",
        "runnerRunning",
        "gatesRunning",
        "retrying",
        "passed",
        "failed",
        "cancelled",
        "skipped",
      ])
    );
    expect(hookStateNames).toEqual(
      expect.arrayContaining(["queued", "running", "passed", "failed"])
    );
    expect(gateStateNames).toEqual(
      expect.arrayContaining(["pending", "running", "passed", "failed"])
    );
    expect(workflowStateNames).toEqual(
      expect.arrayContaining(["planning", "runningBatch", "passed", "failed"])
    );
    expect(runtimeMachineTags).toEqual(
      expect.arrayContaining(["running", "hook", "gate", "retrying"])
    );
  });

  it("creates stable actor IDs from pipeline scope parts", () => {
    expect(
      runtimeActorId("gate", {
        gateId: "review",
        nodeId: "worker",
        runId: "run-1",
        workflowId: "default",
      })
    ).toBe("pipeline.gate.run-1.default.worker.review");
  });
});
