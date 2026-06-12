import type { RuntimeNodeResult } from "./contracts";

const runtimeActorKinds = [
  "pipeline",
  "workflow",
  "node",
  "gate",
  "hook",
] as const;

export type RuntimeActorKind = (typeof runtimeActorKinds)[number];

export type RetryReason = "exit_nonzero" | "gate_failure" | "timeout";

export interface NodeRetryPolicyContract {
  backoffMs: number;
  maxAttempts: number;
  multiplier: number;
  retryOn: RetryReason[];
}

export interface RuntimeActorIdParts {
  gateId?: string;
  hookId?: string;
  nodeId?: string;
  runId?: string;
  workflowId?: string;
}

export function runtimeActorId(
  kind: RuntimeActorKind,
  parts: RuntimeActorIdParts
): string {
  const scoped = [
    parts.runId,
    parts.workflowId,
    parts.nodeId,
    parts.gateId,
    parts.hookId,
  ]
    .filter((part): part is string => Boolean(part))
    .join(".");
  return scoped ? `pipeline.${kind}.${scoped}` : `pipeline.${kind}`;
}

export interface RuntimeActorDescriptor {
  id: string;
  kind: RuntimeActorKind;
  parentId?: string;
  systemId?: string;
}

export type RuntimeObservabilityEvent =
  | {
      actor: RuntimeActorDescriptor;
      state: string;
      tags: string[];
      timestamp: string;
      type: "runtime.state.enter";
    }
  | {
      actor: RuntimeActorDescriptor;
      state: string;
      timestamp: string;
      type: "runtime.state.exit";
    }
  | {
      actor: RuntimeActorDescriptor;
      eventType: string;
      timestamp: string;
      type: "runtime.actor.event";
    }
  | {
      actor: RuntimeActorDescriptor;
      snapshot: unknown;
      timestamp: string;
      type: "runtime.actor.snapshot";
    }
  | {
      actor: RuntimeActorDescriptor;
      hookId: string;
      nodeId?: string;
      timestamp: string;
      type: "runtime.hook.started";
    }
  | {
      actor: RuntimeActorDescriptor;
      hookId: string;
      nodeId?: string;
      passed: boolean;
      reason?: string;
      timestamp: string;
      type: "runtime.hook.finished";
    }
  | {
      actor: RuntimeActorDescriptor;
      hookId: string;
      nodeId?: string;
      reason: string;
      timestamp: string;
      type: "runtime.hook.failed";
    }
  | {
      actor: RuntimeActorDescriptor;
      hookId: string;
      nodeId?: string;
      reason: string;
      timestamp: string;
      type: "runtime.hook.timedOut";
    }
  | {
      actor: RuntimeActorDescriptor;
      hookId: string;
      nodeId?: string;
      reason: string;
      timestamp: string;
      type: "runtime.hook.skipped";
    }
  | {
      actor: RuntimeActorDescriptor;
      gateId: string;
      kind: string;
      nodeId: string;
      timestamp: string;
      type: "runtime.gate.started";
    }
  | {
      actor: RuntimeActorDescriptor;
      gateId: string;
      kind: string;
      nodeId: string;
      passed: boolean;
      reason?: string;
      timestamp: string;
      type: "runtime.gate.finished";
    }
  | {
      actor: RuntimeActorDescriptor;
      gateId: string;
      kind: string;
      nodeId: string;
      reason: string;
      timestamp: string;
      type: "runtime.gate.failed";
    }
  | {
      actor: RuntimeActorDescriptor;
      gateId: string;
      kind: string;
      nodeId: string;
      reason: string;
      timestamp: string;
      type: "runtime.gate.cancelled";
    }
  | {
      actor: RuntimeActorDescriptor;
      nodeId: string;
      timestamp: string;
      type: "runtime.node.started";
    }
  | {
      actor: RuntimeActorDescriptor;
      nodeId: string;
      status: RuntimeNodeResult["status"];
      timestamp: string;
      type: "runtime.node.finished";
    }
  | {
      actor: RuntimeActorDescriptor;
      attempt: number;
      nodeId: string;
      reason: RetryReason;
      timestamp: string;
      type: "runtime.retry.scheduled";
    }
  | {
      actor: RuntimeActorDescriptor;
      attempt: number;
      nodeId: string;
      reason: RetryReason;
      timestamp: string;
      type: "runtime.retry.exhausted";
    };

export type RuntimeObservabilityEmitter = (
  event: RuntimeObservabilityEvent
) => void;
