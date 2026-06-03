import type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
} from "../pipeline-runtime.js";

export type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
} from "../pipeline-runtime.js";

export const runtimeActorKinds = [
  "pipeline",
  "workflow",
  "node",
  "gate",
  "hook",
] as const;

export type RuntimeActorKind = (typeof runtimeActorKinds)[number];

export const runtimeMachineTags = [
  "running",
  "waiting",
  "hook",
  "runner",
  "gate",
  "retrying",
  "terminal",
  "failure",
  "cancelled",
] as const;

export type RuntimeMachineTag = (typeof runtimeMachineTags)[number];

export const workflowStateNames = [
  "planning",
  "startingHooks",
  "scheduling",
  "runningBatch",
  "failFastStopping",
  "cancelling",
  "completingHooks",
  "passed",
  "failed",
  "cancelled",
] as const;

export type WorkflowStateName = (typeof workflowStateNames)[number];

export const nodeStateNames = [
  "pending",
  "ready",
  "startingHooks",
  "snapshotBefore",
  "runnerStarting",
  "runnerRunning",
  "runnerFinished",
  "outputRecording",
  "snapshotAfter",
  "gatesStarting",
  "gatesRunning",
  "gatesFinished",
  "successHooks",
  "retrying",
  "passed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type RuntimeNodeStateName = (typeof nodeStateNames)[number];

export const hookStateNames = [
  "queued",
  "running",
  "passed",
  "failed",
  "timedOut",
  "skipped",
] as const;

export type HookStateName = (typeof hookStateNames)[number];

export const gateStateNames = [
  "pending",
  "running",
  "passed",
  "failed",
  "timedOut",
  "cancelled",
] as const;

export type GateStateName = (typeof gateStateNames)[number];

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

export type HookInvocationEvent =
  | { type: "START" }
  | { reason?: string; type: "CANCEL" };

export type GateEvaluationEvent =
  | { type: "START" }
  | { reason?: string; type: "CANCEL" };

export type NodeExecutionEvent =
  | { at: string; type: "READY" }
  | { at: string; attempt: number; type: "STARTED" }
  | { at: string; type: "START_HOOKS_FINISHED" }
  | { at: string; type: "SNAPSHOT_BEFORE_FINISHED" }
  | { at: string; type: "RUNNER_STARTED" }
  | {
      at: string;
      evidence: string[];
      exitCode: number;
      output: string;
      timedOut?: boolean;
      type: "RUNNER_FINISHED";
    }
  | { at: string; type: "OUTPUT_RECORDED" }
  | { at: string; type: "SNAPSHOT_AFTER_FINISHED" }
  | { at: string; type: "GATES_STARTED" }
  | { at: string; gates: RuntimeGateResult[]; type: "GATES_FINISHED" }
  | { at: string; type: "SUCCESS_HOOKS_STARTED" }
  | {
      at: string;
      attempt: number;
      evidence: string[];
      gate: string;
      policy: NodeRetryPolicyContract;
      reason: string;
      retryReason: RetryReason;
      type: "RETRYING";
    }
  | { at: string; result: RuntimeNodeResult; type: "PASSED" }
  | {
      at: string;
      failure: RuntimeFailure;
      result: RuntimeNodeResult;
      type: "FAILED";
    }
  | { at: string; failure: RuntimeFailure; type: "CANCELLED" }
  | { at: string; reason: string; type: "SKIPPED" };

export type WorkflowSchedulerEvent =
  | { type: "START" }
  | { nodeId: string; result: RuntimeNodeResult; type: "NODE_DONE" }
  | { type: "COMPLETE" }
  | { reason?: string; type: "CANCEL" };

export type WorkflowSchedulerResult = PipelineRuntimeResult;

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
      tags: RuntimeMachineTag[];
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
