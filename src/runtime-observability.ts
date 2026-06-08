export type {
  RuntimeActorDescriptor,
  RuntimeActorKind,
  RuntimeMachineTag,
  RuntimeObservabilityEmitter,
  RuntimeObservabilityEvent,
} from "./runtime-machines/contracts";

import type {
  RuntimeActorDescriptor,
  RuntimeMachineTag,
  RuntimeObservabilityEmitter,
  RuntimeObservabilityEvent,
} from "./runtime-machines/contracts";

export function runtimeTimestamp(): string {
  return new Date().toISOString();
}

export function emitRuntimeStateEnter(
  emit: RuntimeObservabilityEmitter | undefined,
  actor: RuntimeActorDescriptor,
  state: string,
  tags: RuntimeMachineTag[] = []
): void {
  emit?.({
    actor,
    state,
    tags,
    timestamp: runtimeTimestamp(),
    type: "runtime.state.enter",
  });
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

export function createRuntimeObservabilityCollector(): {
  emit: RuntimeObservabilityEmitter;
  events: RuntimeObservabilityEvent[];
} {
  const events: RuntimeObservabilityEvent[] = [];
  return {
    emit: (event) => events.push(event),
    events,
  };
}
