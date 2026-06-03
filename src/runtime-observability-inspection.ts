import type {
  RuntimeActorDescriptor,
  RuntimeActorKind,
  RuntimeObservabilityEmitter,
} from "./runtime-machines/contracts.js";
import {
  emitRuntimeActorEvent,
  emitRuntimeSnapshot,
} from "./runtime-observability.js";

const RUNTIME_ACTOR_ID_RE =
  /^pipeline\.(pipeline|workflow|node|gate|hook)(\.|$)/;

export interface XStateInspectionEvent {
  actorRef?: { id?: string; sessionId?: string };
  event?: { type?: string };
  rootId?: string;
  snapshot?: unknown;
  sourceRef?: { id?: string; sessionId?: string };
  transitions?: Array<{ eventType?: string; target?: string[] }>;
  type: string;
  value?: unknown;
}

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
  const id = event.actorRef?.id ?? event.actorRef?.sessionId ?? "unknown";
  return {
    id,
    kind: inspectionActorKind(id),
    ...(event.rootId ? { systemId: event.rootId } : {}),
  };
}

function inspectionActorKind(id: string): RuntimeActorKind {
  const match = RUNTIME_ACTOR_ID_RE.exec(id);
  return match ? (match[1] as RuntimeActorKind) : "pipeline";
}
