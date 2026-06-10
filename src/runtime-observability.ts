export type {
  RuntimeActorDescriptor,
  RuntimeObservabilityEmitter,
  RuntimeObservabilityEvent,
} from "./runtime-machines/contracts";

import type {
  RuntimeActorDescriptor,
  RuntimeObservabilityEmitter,
} from "./runtime-machines/contracts";

function runtimeTimestamp(): string {
  return new Date().toISOString();
}

export function emitRuntimeActorEvent(
  emit: RuntimeObservabilityEmitter | undefined,
  actor: RuntimeActorDescriptor,
  eventType: string
): void {
  emit?.({
    actor,
    eventType,
    timestamp: runtimeTimestamp(),
    type: "runtime.actor.event",
  });
}

export function emitRuntimeSnapshot(
  emit: RuntimeObservabilityEmitter | undefined,
  actor: RuntimeActorDescriptor,
  snapshot: unknown
): void {
  emit?.({
    actor,
    snapshot,
    timestamp: runtimeTimestamp(),
    type: "runtime.actor.snapshot",
  });
}
