import { describe, expect, it } from "vitest";
import {
  type NodeExecutionEvent,
  NodeStateTracker,
} from "../src/runtime/node-state-tracker";

const AT = "2026-06-03T00:00:00.000Z";

function recordStartedAttempt(
  tracker: NodeStateTracker,
  attempt: number,
  runner: Extract<NodeExecutionEvent, { type: "RUNNER_FINISHED" }>
): void {
  tracker.record({ at: AT, type: "READY" });
  tracker.record({ at: AT, attempt, type: "STARTED" });
  tracker.record({ at: AT, type: "START_HOOKS_FINISHED" });
  tracker.record({ at: AT, type: "SNAPSHOT_BEFORE_FINISHED" });
  tracker.record({ at: AT, type: "RUNNER_STARTED" });
  tracker.record(runner);
  tracker.record({ at: AT, type: "OUTPUT_RECORDED" });
  tracker.record({ at: AT, type: "SNAPSHOT_AFTER_FINISHED" });
  tracker.record({ at: AT, type: "GATES_STARTED" });
  tracker.record({ at: AT, gates: [], type: "GATES_FINISHED" });
}

describe("NodeStateTracker", () => {
  it("records retrying and passed node snapshots without an xstate actor", () => {
    const tracker = new NodeStateTracker("worker");

    recordStartedAttempt(tracker, 1, {
      at: AT,
      evidence: ["exit 1"],
      exitCode: 1,
      output: "bad",
      type: "RUNNER_FINISHED",
    });
    tracker.record({
      at: AT,
      attempt: 1,
      evidence: ["exit 1"],
      gate: "worker",
      reason: "node exited with code 1",
      retry: {
        attempt: 1,
        delayMs: 100,
        evidence: ["exit 1"],
        exhausted: false,
        gate: "worker",
        reason: "node exited with code 1",
        retryReason: "exit_nonzero",
        scheduled: true,
      },
      retryReason: "exit_nonzero",
      type: "RETRYING",
    });

    expect(tracker.getState().retry).toMatchObject({
      attempt: 1,
      delayMs: 100,
      retryReason: "exit_nonzero",
      scheduled: true,
    });
    expect(tracker.getState()).toMatchObject({
      attempts: 1,
      status: "running",
    });

    tracker.record({
      at: "2026-06-03T00:00:01.000Z",
      attempt: 2,
      type: "STARTED",
    });
    expect(tracker.getState()).toMatchObject({
      attempts: 2,
      status: "running",
    });
  });

  it("records retry exhaustion and cancelled terminal transitions", () => {
    const retryTracker = new NodeStateTracker("retry-worker");

    recordStartedAttempt(retryTracker, 2, {
      at: AT,
      evidence: ["exit 1"],
      exitCode: 1,
      output: "bad",
      type: "RUNNER_FINISHED",
    });
    retryTracker.record({
      at: AT,
      attempt: 2,
      evidence: ["exit 1"],
      gate: "retry-worker",
      reason: "node exited with code 1",
      retry: {
        attempt: 2,
        delayMs: 0,
        evidence: ["exit 1"],
        exhausted: true,
        gate: "retry-worker",
        reason: "node exited with code 1",
        retryReason: "exit_nonzero",
        scheduled: false,
      },
      retryReason: "exit_nonzero",
      type: "RETRYING",
    });

    expect(retryTracker.getState().retry).toMatchObject({
      delayMs: 0,
      exhausted: true,
      scheduled: false,
    });

    const tracker = new NodeStateTracker("worker");

    recordStartedAttempt(tracker, 1, {
      at: AT,
      evidence: ["ok"],
      exitCode: 0,
      output: "ok",
      type: "RUNNER_FINISHED",
    });
    tracker.record({
      at: AT,
      failure: {
        evidence: ["pipeline cancelled by AbortSignal"],
        gate: "cancelled",
        nodeId: "worker",
        reason: "pipeline cancelled",
      },
      type: "CANCELLED",
    });

    expect(tracker.getState()).toMatchObject({
      failure: expect.objectContaining({ reason: "pipeline cancelled" }),
      status: "cancelled",
    });
  });

  it("records skipped node transitions through the tracker", () => {
    const tracker = new NodeStateTracker("skipped-worker");

    tracker.record({ at: AT, type: "READY" });
    tracker.record({
      at: AT,
      reason: "blocked by dependency",
      type: "SKIPPED",
    });

    expect(tracker.getState()).toMatchObject({
      failure: {
        evidence: ["blocked by dependency"],
        gate: "skipped-worker",
        nodeId: "skipped-worker",
        reason: "blocked by dependency",
      },
      finishedAt: AT,
      status: "skipped",
    });
  });
});
