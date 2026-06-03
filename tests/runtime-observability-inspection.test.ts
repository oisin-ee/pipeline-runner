import { describe, expect, it } from "vitest";
import type { RuntimeObservabilityEvent } from "../src/runtime-observability.js";
import { createRuntimeInspectionBridge } from "../src/runtime-observability-inspection.js";

describe("createRuntimeInspectionBridge", () => {
  it("classifies inspected runtime actors by stable actor id prefix", () => {
    const events: RuntimeObservabilityEvent[] = [];
    const bridge = createRuntimeInspectionBridge({
      emit: (event) => events.push(event),
    });

    bridge({
      actorRef: { id: "pipeline.gate.run-1.default.verify.review" },
      rootId: "pipeline.run-1.default",
      type: "@xstate.actor",
    });

    expect(events).toEqual([
      expect.objectContaining({
        actor: {
          id: "pipeline.gate.run-1.default.verify.review",
          kind: "gate",
          systemId: "pipeline.run-1.default",
        },
        type: "runtime.state.enter",
      }),
    ]);
  });
});
