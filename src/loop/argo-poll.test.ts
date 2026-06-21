import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowReadApi } from "./argo-poll";
import {
  ARGO_PENDING_PHASE,
  pollWorkflowPhaseUntilTerminal,
} from "./argo-poll";

// Minimal fake: returns phases in order, one per call.
function fakeWorkflowReadApi(phases: Array<string | Error>): {
  api: WorkflowReadApi;
  callCount: () => number;
} {
  let calls = 0;
  const remaining = [...phases];
  const api: WorkflowReadApi = {
    getNamespacedCustomObject: vi.fn(() => {
      calls++;
      const next = remaining.shift();
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve({ status: { phase: next ?? ARGO_PENDING_PHASE } });
    }),
  };
  return { api, callCount: () => calls };
}

describe("pollWorkflowPhaseUntilTerminal", () => {
  it("AC1: polls Running→Running→Succeeded and resolves with Succeeded", async () => {
    const { api } = fakeWorkflowReadApi(["Running", "Running", "Succeeded"]);

    const result = await Effect.runPromise(
      pollWorkflowPhaseUntilTerminal({
        namespace: "default",
        workflowName: "wf-abc",
        workflowReadApi: api,
        pollIntervalMs: 0,
        maxRetries: 3,
      })
    );

    expect(result).toBe("Succeeded");
  });

  it("AC1: polls until Failed and resolves with Failed", async () => {
    const { api } = fakeWorkflowReadApi(["Running", "Failed"]);

    const result = await Effect.runPromise(
      pollWorkflowPhaseUntilTerminal({
        namespace: "default",
        workflowName: "wf-abc",
        workflowReadApi: api,
        pollIntervalMs: 0,
        maxRetries: 3,
      })
    );

    expect(result).toBe("Failed");
  });

  it("AC3: Error phase resolves as terminal TerminalPhase", async () => {
    const { api } = fakeWorkflowReadApi(["Running", "Error"]);

    const result = await Effect.runPromise(
      pollWorkflowPhaseUntilTerminal({
        namespace: "default",
        workflowName: "wf-abc",
        workflowReadApi: api,
        pollIntervalMs: 0,
        maxRetries: 3,
      })
    );

    expect(result).toBe("Error");
  });

  it("AC2: transient API error is retried, logged, and not swallowed — resolves after recovery", async () => {
    const logged: string[] = [];
    const { api, callCount } = fakeWorkflowReadApi([
      new Error("connection reset"),
      new Error("connection reset"),
      "Succeeded",
    ]);

    const result = await Effect.runPromise(
      pollWorkflowPhaseUntilTerminal({
        namespace: "default",
        workflowName: "wf-abc",
        workflowReadApi: api,
        pollIntervalMs: 0,
        maxRetries: 3,
        onTransientError: (err, attempt) =>
          logged.push(`attempt=${attempt} err=${String(err)}`),
      })
    );

    expect(result).toBe("Succeeded");
    // Called 3 times: 2 errors + 1 success
    expect(callCount()).toBe(3);
    // Each transient error was surfaced to the logger
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("connection reset");
    expect(logged[1]).toContain("connection reset");
  });

  it("AC2: exhausted retry budget fails the Effect, not silently terminates", async () => {
    const { api } = fakeWorkflowReadApi([
      new Error("network timeout"),
      new Error("network timeout"),
      new Error("network timeout"),
      new Error("network timeout"),
    ]);

    await expect(
      Effect.runPromise(
        pollWorkflowPhaseUntilTerminal({
          namespace: "default",
          workflowName: "wf-abc",
          workflowReadApi: api,
          pollIntervalMs: 0,
          maxRetries: 2,
        })
      )
    ).rejects.toThrow("network timeout");
  });

  it("pending/blank phase keeps polling until terminal", async () => {
    // Argo uses an absent/blank phase as the initial pending state — classifyPhase maps
    // it to RunningPhase so the poll loop continues.
    const { api, callCount } = fakeWorkflowReadApi([
      ARGO_PENDING_PHASE,
      "Running",
      "Succeeded",
    ]);

    const result = await Effect.runPromise(
      pollWorkflowPhaseUntilTerminal({
        namespace: "default",
        workflowName: "wf-abc",
        workflowReadApi: api,
        pollIntervalMs: 0,
        maxRetries: 3,
      })
    );

    expect(result).toBe("Succeeded");
    expect(callCount()).toBe(3);
  });
});
