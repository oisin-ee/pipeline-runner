import { describe, expect, it } from "vitest";

import type { PlannedWorkflowNode } from "../src/planning/compile";
import type { RetryReason } from "../src/runtime/actor-ids";
import { decideNodeRetry, nodeRetryPolicy, retryDelayMs } from "../src/runtime/retry";

const nodeWithRetries = (retries?: PlannedWorkflowNode["retries"]): PlannedWorkflowNode => ({
  command: ["false"],
  dependents: [],
  id: "flaky",
  index: 0,
  kind: "command",
  needs: [],
  retries,
});

describe("runtime retry policy", () => {
  it("preserves default retry reasons and configured retry_on overrides", () => {
    expect(nodeRetryPolicy(nodeWithRetries())).toEqual({
      backoffMs: 0,
      maxAttempts: 1,
      multiplier: 1,
      retryOn: ["exit_nonzero", "gate_failure", "timeout"],
    });

    expect(
      nodeRetryPolicy(
        nodeWithRetries({
          backoff_ms: 250,
          max_attempts: 4,
          multiplier: 3,
          retry_on: ["timeout"],
        }),
      ),
    ).toEqual({
      backoffMs: 250,
      maxAttempts: 4,
      multiplier: 3,
      retryOn: ["timeout"],
    });
  });

  it("uses the existing backoff multiplier formula for every retry reason", () => {
    const policy = {
      backoffMs: 100,
      maxAttempts: 4,
      multiplier: 3,
      retryOn: ["exit_nonzero", "gate_failure", "timeout"] as RetryReason[],
    };

    expect(retryDelayMs(policy, 1)).toBe(100);
    expect(retryDelayMs(policy, 2)).toBe(300);
    expect(retryDelayMs({ ...policy, multiplier: 0 }, 3)).toBe(100);
  });

  it("decides scheduled versus exhausted retries without consulting node state snapshots", () => {
    const policy = {
      backoffMs: 50,
      maxAttempts: 3,
      multiplier: 2,
      retryOn: ["gate_failure", "timeout"] as RetryReason[],
    };

    expect(
      decideNodeRetry({
        attempt: 2,
        evidence: ["gate failed"],
        gate: "acceptance",
        policy,
        reason: "gate failed",
        retryReason: "gate_failure",
      }),
    ).toEqual({
      attempt: 2,
      delayMs: 100,
      evidence: ["gate failed"],
      exhausted: false,
      gate: "acceptance",
      reason: "gate failed",
      retryReason: "gate_failure",
      scheduled: true,
    });

    expect(
      decideNodeRetry({
        attempt: 1,
        evidence: ["exit 1"],
        gate: "flaky",
        policy,
        reason: "node exited with code 1",
        retryReason: "exit_nonzero",
      }),
    ).toMatchObject({ delayMs: 0, exhausted: true, scheduled: false });

    expect(
      decideNodeRetry({
        attempt: 3,
        evidence: ["timed out"],
        gate: "flaky",
        policy,
        reason: "node timed out",
        retryReason: "timeout",
      }),
    ).toMatchObject({ delayMs: 0, exhausted: true, scheduled: false });
  });
});
