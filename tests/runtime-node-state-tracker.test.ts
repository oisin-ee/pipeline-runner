import { describe, expect, it } from "vitest";

import { NodeStateTracker } from "../src/runtime/node-state-tracker";
import type { NodeExecutionEvent } from "../src/runtime/node-state-tracker";

const AT = "2026-06-03T00:00:00.000Z";

const recordStartedAttempt = (
  tracker: NodeStateTracker,
  attempt: number,
  runner: Extract<NodeExecutionEvent, { type: "RUNNER_FINISHED" }>,
): void => {
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
};

const passedEvent = (nodeId = "worker", attempt = 1): Extract<NodeExecutionEvent, { type: "PASSED" }> => ({
  at: AT,
  result: {
    attempts: attempt,
    evidence: ["ok"],
    exitCode: 0,
    nodeId,
    output: "ok",
    status: "passed",
  },
  type: "PASSED",
});

const failedEvent = (nodeId = "worker", attempt = 1): Extract<NodeExecutionEvent, { type: "FAILED" }> => ({
  at: AT,
  failure: {
    evidence: ["exit 1"],
    gate: nodeId,
    nodeId,
    reason: "node exited with code 1",
  },
  result: {
    attempts: attempt,
    evidence: ["exit 1"],
    exitCode: 1,
    nodeId,
    output: "bad",
    status: "failed",
  },
  type: "FAILED",
});

const retryingEvent = (nodeId = "worker", attempt = 1): Extract<NodeExecutionEvent, { type: "RETRYING" }> => ({
  at: AT,
  attempt,
  evidence: ["exit 1"],
  gate: nodeId,
  reason: "node exited with code 1",
  retry: {
    attempt,
    delayMs: 100,
    evidence: ["exit 1"],
    exhausted: false,
    gate: nodeId,
    reason: "node exited with code 1",
    retryReason: "exit_nonzero",
    scheduled: true,
  },
  retryReason: "exit_nonzero",
  type: "RETRYING",
});

describe("NodeStateTracker", () => {
  it("accepts documented pass, fail, retry, remediation pass, cancel, and skip flows", () => {
    const passTracker = new NodeStateTracker("pass-worker");
    recordStartedAttempt(passTracker, 1, {
      at: AT,
      evidence: ["ok"],
      exitCode: 0,
      output: "ok",
      type: "RUNNER_FINISHED",
    });
    passTracker.record(passedEvent("pass-worker"));
    expect(passTracker.getState()).toMatchObject({
      attempts: 1,
      status: "passed",
    });

    const failTracker = new NodeStateTracker("fail-worker");
    recordStartedAttempt(failTracker, 1, {
      at: AT,
      evidence: ["exit 1"],
      exitCode: 1,
      output: "bad",
      type: "RUNNER_FINISHED",
    });
    failTracker.record(failedEvent("fail-worker"));
    expect(failTracker.getState()).toMatchObject({
      attempts: 1,
      failure: expect.objectContaining({ reason: "node exited with code 1" }),
      status: "failed",
    });

    const retryTracker = new NodeStateTracker("retry-worker");
    recordStartedAttempt(retryTracker, 1, {
      at: AT,
      evidence: ["exit 1"],
      exitCode: 1,
      output: "bad",
      type: "RUNNER_FINISHED",
    });
    retryTracker.record(retryingEvent("retry-worker"));
    retryTracker.record({
      at: AT,
      attempt: 2,
      type: "STARTED",
    });
    expect(retryTracker.getState()).toMatchObject({
      attempts: 2,
      status: "running",
    });

    const remediationTracker = new NodeStateTracker("remediated-worker");
    recordStartedAttempt(remediationTracker, 1, {
      at: AT,
      evidence: ["coverage failed"],
      exitCode: 0,
      output: "review",
      type: "RUNNER_FINISHED",
    });
    remediationTracker.record(passedEvent("remediated-worker"));
    expect(remediationTracker.getState()).toMatchObject({
      status: "passed",
    });

    const cancelTracker = new NodeStateTracker("cancel-worker");
    cancelTracker.record({ at: AT, type: "READY" });
    cancelTracker.record({ at: AT, attempt: 1, type: "STARTED" });
    cancelTracker.record({
      at: AT,
      failure: {
        evidence: ["pipeline cancelled by AbortSignal"],
        gate: "cancelled",
        nodeId: "cancel-worker",
        reason: "pipeline cancelled",
      },
      type: "CANCELLED",
    });
    expect(cancelTracker.getState()).toMatchObject({
      status: "cancelled",
    });

    const skipTracker = new NodeStateTracker("skip-worker");
    skipTracker.record({ at: AT, type: "READY" });
    skipTracker.record({
      at: AT,
      reason: "blocked by dependency",
      type: "SKIPPED",
    });
    expect(skipTracker.getState()).toMatchObject({
      status: "skipped",
    });
  });

  it("rejects illegal lifecycle events before mutating state", () => {
    const pendingTracker = new NodeStateTracker("pending-worker");
    expect(() => pendingTracker.record({ at: AT, attempt: 1, type: "STARTED" })).toThrow(
      "Illegal NodeExecutionEvent STARTED from node status pending; allowed from: ready, running",
    );
    expect(pendingTracker.getState()).toMatchObject({
      attempts: 0,
      status: "pending",
    });

    const readyTracker = new NodeStateTracker("ready-worker");
    readyTracker.record({ at: AT, type: "READY" });
    expect(() => readyTracker.record(passedEvent("ready-worker"))).toThrow(
      "Illegal NodeExecutionEvent PASSED from node status ready; allowed from: running, gating",
    );
    expect(readyTracker.getState()).toMatchObject({
      status: "ready",
    });

    const runningTracker = new NodeStateTracker("running-worker");
    runningTracker.record({ at: AT, type: "READY" });
    runningTracker.record({ at: AT, attempt: 1, type: "STARTED" });
    expect(() => runningTracker.record({ at: AT, gates: [], type: "GATES_FINISHED" })).toThrow(
      "Illegal NodeExecutionEvent GATES_FINISHED from node status running; allowed from: gating",
    );
    expect(runningTracker.getState()).toMatchObject({
      gates: [],
      status: "running",
    });

    const terminalTracker = new NodeStateTracker("terminal-worker");
    recordStartedAttempt(terminalTracker, 1, {
      at: AT,
      evidence: ["ok"],
      exitCode: 0,
      output: "ok",
      type: "RUNNER_FINISHED",
    });
    terminalTracker.record(passedEvent("terminal-worker"));
    expect(() => terminalTracker.record({ at: AT, type: "READY" })).toThrow(
      "Illegal NodeExecutionEvent READY from node status passed; allowed from: pending",
    );
    expect(terminalTracker.getState()).toMatchObject({
      status: "passed",
    });
  });

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
