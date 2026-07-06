import { describe, expect, it } from "vitest";

import { runtimeActorId } from "../src/runtime/actor-ids";
import type {
  NodeRetryPolicyContract,
  RetryReason,
  RuntimeActorDescriptor,
  RuntimeActorIdParts,
  RuntimeActorKind,
  RuntimeObservabilityEmitter,
  RuntimeObservabilityEvent,
} from "../src/runtime/actor-ids";

describe("public runtime actor/retry contracts", () => {
  it("are owned by the non-machine actor id module", () => {
    const parts: RuntimeActorIdParts = {
      gateId: "review",
      hookId: "after",
      nodeId: "verify",
      runId: "run-1",
      workflowId: "default",
    };
    const kind: RuntimeActorKind = "node";
    const actor: RuntimeActorDescriptor = {
      id: runtimeActorId(kind, parts),
      kind,
      parentId: runtimeActorId("workflow", parts),
      systemId: "system-1",
    };
    const reason: RetryReason = "gate_failure";
    const policy: NodeRetryPolicyContract = {
      backoffMs: 1000,
      maxAttempts: 3,
      multiplier: 2,
      retryOn: [reason],
    };
    const event: RuntimeObservabilityEvent = {
      actor,
      attempt: policy.maxAttempts,
      nodeId: "verify",
      reason,
      timestamp: "2026-06-12T00:00:00.000Z",
      type: "runtime.retry.scheduled",
    };
    const emitted: RuntimeObservabilityEvent[] = [];
    const emit: RuntimeObservabilityEmitter = (next: RuntimeObservabilityEvent) => emitted.push(next);

    emit(event);

    expect(emitted).toEqual([event]);
  });

  it("keeps runtimeActorId output byte-identical for workflow, node, gate, and hook actors", () => {
    expect(
      runtimeActorId("workflow", {
        runId: "run-1",
        workflowId: "default",
      }),
    ).toBe("pipeline.workflow.run-1.default");

    expect(
      runtimeActorId("node", {
        nodeId: "verify",
        runId: "run-1",
        workflowId: "default",
      }),
    ).toBe("pipeline.node.run-1.default.verify");

    expect(
      runtimeActorId("gate", {
        gateId: "review",
        nodeId: "verify",
        runId: "run-1",
        workflowId: "default",
      }),
    ).toBe("pipeline.gate.run-1.default.verify.review");

    expect(
      runtimeActorId("hook", {
        hookId: "post-check",
        nodeId: "build",
        runId: "run-1",
        workflowId: "default",
      }),
    ).toBe("pipeline.hook.run-1.default.build.post-check");

    expect(
      runtimeActorId("hook", {
        hookId: "on-start",
        runId: "run-1",
        workflowId: "default",
      }),
    ).toBe("pipeline.hook.run-1.default.on-start");
  });
});
