import type {
  RuntimeActorDescriptor,
  RuntimeObservabilityEmitter,
} from "./runtime-machines/contracts.js";
import {
  emitRuntimeActorEvent,
  emitRuntimeSnapshot,
} from "./runtime-observability.js";

export type XStateInspectionEvent =
  | {
      actorRef?: { id?: string; sessionId?: string };
      rootId?: string;
      type: "@xstate.actor";
    }
  | {
      actorRef?: { id?: string; sessionId?: string };
      event?: { type?: string };
      rootId?: string;
      sourceRef?: { id?: string; sessionId?: string };
      type: "@xstate.event";
    }
  | {
      actorRef?: { id?: string; sessionId?: string };
      rootId?: string;
      snapshot?: unknown;
      type: "@xstate.snapshot";
    }
  | {
      actorRef?: { id?: string; sessionId?: string };
      event?: { type?: string };
      rootId?: string;
      transitions?: Array<{ eventType?: string; target?: string[] }>;
      type: "@xstate.microstep";
      value?: unknown;
    };

export interface RuntimeInspectionBridgeOptions {
  emit: RuntimeObservabilityEmitter;
  redactSnapshots?: boolean;
  snapshotRedactionText?: string;
}

export function createRuntimeInspectionBridge(
  options: RuntimeInspectionBridgeOptions
): (event: XStateInspectionEvent) => void {
  return (event) => {
    const actor = inspectionActor(event);
    switch (event.type) {
      case "@xstate.actor":
        options.emit({
          actor,
          state: "created",
          tags: [],
          timestamp: new Date().toISOString(),
          type: "runtime.state.enter",
        });
        return;
      case "@xstate.event":
        emitRuntimeActorEvent(
          options.emit,
          actor,
          event.event?.type ?? "unknown"
        );
        return;
      case "@xstate.snapshot":
        emitRuntimeSnapshot(
          options.emit,
          actor,
          options.redactSnapshots === false
            ? event.snapshot
            : (options.snapshotRedactionText ?? "[redacted]")
        );
        return;
      case "@xstate.microstep":
        options.emit({
          actor,
          state: String(event.value ?? "unknown"),
          tags: [],
          timestamp: new Date().toISOString(),
          type: "runtime.state.enter",
        });
        return;
      default:
        return;
    }
  };
}

function inspectionActor(event: XStateInspectionEvent): RuntimeActorDescriptor {
  return {
    id: event.actorRef?.id ?? event.actorRef?.sessionId ?? "unknown",
    kind: "pipeline",
    ...(event.rootId ? { systemId: event.rootId } : {}),
  };
}
