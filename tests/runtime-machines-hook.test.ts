import { describe, expect, it } from "vitest";
import { createActor, waitFor } from "xstate";
import { runtimeActorId } from "../src/runtime-machines/contracts.js";
import { hookInvocationMachine } from "../src/runtime-machines/hook-machine.js";

describe("hookInvocationMachine", () => {
  it("records a passing command hook", async () => {
    const actor = createActor(hookInvocationMachine, {
      input: {
        actor: {
          id: runtimeActorId("hook", { hookId: "start" }),
          kind: "hook",
        },
        execute: () => ({ status: "passed" }),
        hookId: "start",
        required: true,
      },
    });

    actor.start();
    actor.send({ type: "START" });
    const snapshot = await waitFor(actor, (state) => state.status === "done");

    expect(snapshot.value).toBe("passed");
    expect(snapshot.context.result).toMatchObject({ status: "passed" });
  });

  it("keeps required hook failure visible", async () => {
    const actor = createActor(hookInvocationMachine, {
      input: {
        actor: {
          id: runtimeActorId("hook", { hookId: "start" }),
          kind: "hook",
        },
        execute: () => ({
          failure: {
            evidence: ["exit 1"],
            gate: "start",
            reason: "hook 'start' failed",
          },
          status: "failed",
        }),
        hookId: "start",
        required: true,
      },
    });

    actor.start();
    actor.send({ type: "START" });
    const snapshot = await waitFor(actor, (state) => state.status === "done");

    expect(snapshot.value).toBe("failed");
    expect(snapshot.context.result?.failure?.gate).toBe("start");
  });
});
