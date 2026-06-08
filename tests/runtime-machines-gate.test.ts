import { describe, expect, it } from "vitest";
import { createActor, waitFor } from "xstate";
import { runtimeActorId } from "../src/runtime-machines/contracts";
import { gateEvaluationMachine } from "../src/runtime-machines/gate-machine";

describe("gateEvaluationMachine", () => {
  it("classifies a passing gate result", async () => {
    const actor = createActor(gateEvaluationMachine, {
      input: {
        actor: {
          id: runtimeActorId("gate", { gateId: "artifact" }),
          kind: "gate",
        },
        evaluate: () => ({
          evidence: ["artifact exists"],
          gateId: "artifact",
          kind: "artifact",
          nodeId: "build",
          passed: true,
        }),
        gateId: "artifact",
        kind: "artifact",
        nodeId: "build",
      },
    });

    actor.start();
    actor.send({ type: "START" });
    const snapshot = await waitFor(actor, (state) => state.status === "done");

    expect(snapshot.value).toBe("passed");
    expect(snapshot.context.result?.passed).toBe(true);
  });

  it("classifies a failing gate result", async () => {
    const actor = createActor(gateEvaluationMachine, {
      input: {
        actor: {
          id: runtimeActorId("gate", { gateId: "verdict" }),
          kind: "gate",
        },
        evaluate: () => ({
          evidence: ["verdict expected PASS"],
          gateId: "verdict",
          kind: "verdict",
          nodeId: "review",
          passed: false,
          reason: "verdict requirement failed",
        }),
        gateId: "verdict",
        kind: "verdict",
        nodeId: "review",
      },
    });

    actor.start();
    actor.send({ type: "START" });
    const snapshot = await waitFor(actor, (state) => state.status === "done");

    expect(snapshot.value).toBe("failed");
    expect(snapshot.context.result?.reason).toBe("verdict requirement failed");
  });
});
