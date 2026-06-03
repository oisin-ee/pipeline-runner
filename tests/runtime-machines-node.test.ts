import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { runtimeActorId } from "../src/runtime-machines/contracts.js";
import { nodeExecutionMachine } from "../src/runtime-machines/node-machine.js";

describe("nodeExecutionMachine", () => {
  it("records retrying and passed node snapshots", () => {
    const actor = createActor(nodeExecutionMachine, {
      input: {
        actor: {
          id: runtimeActorId("node", { nodeId: "worker" }),
          kind: "node",
        },
        nodeId: "worker",
      },
    });

    actor.start();
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "READY" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      attempt: 1,
      type: "STARTED",
    });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "START_HOOKS_FINISHED",
    });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "SNAPSHOT_BEFORE_FINISHED",
    });
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "RUNNER_STARTED" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      evidence: ["exit 1"],
      exitCode: 1,
      output: "bad",
      type: "RUNNER_FINISHED",
    });
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "OUTPUT_RECORDED" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "SNAPSHOT_AFTER_FINISHED",
    });
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "GATES_STARTED" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      gates: [],
      type: "GATES_FINISHED",
    });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      attempt: 1,
      evidence: ["exit 1"],
      gate: "worker",
      policy: {
        backoffMs: 100,
        maxAttempts: 2,
        multiplier: 2,
        retryOn: ["exit_nonzero"],
      },
      reason: "node exited with code 1",
      retryReason: "exit_nonzero",
      type: "RETRYING",
    });

    expect(actor.getSnapshot().value).toBe("retrying");
    expect(actor.getSnapshot().context.state.retry).toMatchObject({
      delayMs: 100,
      retryReason: "exit_nonzero",
      scheduled: true,
    });

    actor.send({
      at: "2026-06-03T00:00:01.000Z",
      attempt: 2,
      type: "STARTED",
    });
    expect(actor.getSnapshot().context.state.attempts).toBe(2);
  });

  it("owns retry exhaustion decisions and cancelled terminal transitions", () => {
    const retryActor = createActor(nodeExecutionMachine, {
      input: {
        actor: {
          id: runtimeActorId("node", { nodeId: "retry-worker" }),
          kind: "node",
        },
        nodeId: "retry-worker",
      },
    });

    retryActor.start();
    retryActor.send({ at: "2026-06-03T00:00:00.000Z", type: "READY" });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      attempt: 2,
      type: "STARTED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "START_HOOKS_FINISHED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "SNAPSHOT_BEFORE_FINISHED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "RUNNER_STARTED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      evidence: ["exit 1"],
      exitCode: 1,
      output: "bad",
      type: "RUNNER_FINISHED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "OUTPUT_RECORDED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "SNAPSHOT_AFTER_FINISHED",
    });
    retryActor.send({ at: "2026-06-03T00:00:00.000Z", type: "GATES_STARTED" });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      gates: [],
      type: "GATES_FINISHED",
    });
    retryActor.send({
      at: "2026-06-03T00:00:00.000Z",
      attempt: 2,
      evidence: ["exit 1"],
      gate: "retry-worker",
      policy: {
        backoffMs: 100,
        maxAttempts: 2,
        multiplier: 2,
        retryOn: ["exit_nonzero"],
      },
      reason: "node exited with code 1",
      retryReason: "exit_nonzero",
      type: "RETRYING",
    });

    expect(retryActor.getSnapshot().context.state.retry).toMatchObject({
      delayMs: 0,
      exhausted: true,
      scheduled: false,
    });

    const actor = createActor(nodeExecutionMachine, {
      input: {
        actor: {
          id: runtimeActorId("node", { nodeId: "worker" }),
          kind: "node",
        },
        nodeId: "worker",
      },
    });

    actor.start();
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "READY" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      attempt: 1,
      type: "STARTED",
    });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "START_HOOKS_FINISHED",
    });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "SNAPSHOT_BEFORE_FINISHED",
    });
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "RUNNER_STARTED" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      evidence: ["ok"],
      exitCode: 0,
      output: "ok",
      type: "RUNNER_FINISHED",
    });
    actor.send({ at: "2026-06-03T00:00:00.000Z", type: "OUTPUT_RECORDED" });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      type: "SNAPSHOT_AFTER_FINISHED",
    });
    actor.send({
      at: "2026-06-03T00:00:00.000Z",
      failure: {
        evidence: ["pipeline cancelled by AbortSignal"],
        gate: "cancelled",
        nodeId: "worker",
        reason: "pipeline cancelled",
      },
      type: "CANCELLED",
    });

    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().context.state.status).toBe("cancelled");
  });
});
