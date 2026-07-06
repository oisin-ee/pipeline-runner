import type { RetryReason } from "./actor-ids";
import type { NodeExecutionState, NodeStatus, RuntimeFailure, RuntimeGateResult, RuntimeNodeResult } from "./contracts";
import type { NodeRetryDecision } from "./retry";

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
      reason: string;
      retry: NodeRetryDecision;
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

const initialNodeExecutionState = (nodeId: string): NodeExecutionState => ({
  attempts: 0,
  evidence: [],
  gates: [],
  id: nodeId,
  status: "pending",
});

type NodeExecutionEventHandler<T extends NodeExecutionEvent["type"]> = (
  state: NodeExecutionState,
  event: Extract<NodeExecutionEvent, { type: T }>,
) => NodeExecutionState;

type NodeExecutionEventType = NodeExecutionEvent["type"];

interface NodeExecutionTransition<T extends NodeExecutionEventType> {
  allowedFrom: readonly NodeStatus[];
  apply: NodeExecutionEventHandler<T>;
  statusAfter: NodeStatus;
}

interface RuntimeNodeExecutionTransition {
  allowedFrom: readonly NodeStatus[];
  apply: (state: NodeExecutionState, event: NodeExecutionEvent) => NodeExecutionState;
  statusAfter: NodeStatus;
}

type NodeExecutionTransitions = Record<NodeExecutionEventType, RuntimeNodeExecutionTransition>;

const unchangedNodeState = (state: NodeExecutionState): NodeExecutionState => state;

const isNodeExecutionEventType = <T extends NodeExecutionEventType>(
  event: NodeExecutionEvent,
  type: T,
): event is Extract<NodeExecutionEvent, { type: T }> => event.type === type;

const defineNodeExecutionTransition = <T extends NodeExecutionEventType>(
  type: T,
  transition: NodeExecutionTransition<T>,
): RuntimeNodeExecutionTransition => ({
  allowedFrom: transition.allowedFrom,
  apply: (state, event) => {
    if (!isNodeExecutionEventType(event, type)) {
      throw new Error(`NodeExecutionEvent handler ${type} received ${event.type}`);
    }
    return transition.apply(state, event);
  },
  statusAfter: transition.statusAfter,
});

const assertNodeExecutionTransitionAllowed = (
  state: NodeExecutionState,
  event: NodeExecutionEvent,
  transition: RuntimeNodeExecutionTransition,
): void => {
  if (transition.allowedFrom.includes(state.status)) {
    return;
  }

  throw new Error(
    `Illegal NodeExecutionEvent ${event.type} from node status ${state.status}; allowed from: ${transition.allowedFrom.join(", ")}`,
  );
};

const stateFromResult = (state: NodeExecutionState, result: RuntimeNodeResult, at: string): NodeExecutionState => ({
  ...state,
  attempts: result.attempts,
  evidence: result.evidence,
  exitCode: result.exitCode,
  finishedAt: at,
  output: result.output,
});

const nodeExecutionTransitions: NodeExecutionTransitions = {
  CANCELLED: defineNodeExecutionTransition("CANCELLED", {
    allowedFrom: ["running", "gating"],
    apply: (state, event) => ({
      ...state,
      failure: event.failure,
      finishedAt: event.at,
    }),
    statusAfter: "cancelled",
  }),
  FAILED: defineNodeExecutionTransition("FAILED", {
    allowedFrom: ["running", "gating"],
    apply: (state, event) => ({
      ...stateFromResult(state, event.result, event.at),
      failure: event.failure,
    }),
    statusAfter: "failed",
  }),
  GATES_FINISHED: defineNodeExecutionTransition("GATES_FINISHED", {
    allowedFrom: ["gating"],
    apply: (state, event) => ({ ...state, gates: event.gates }),
    statusAfter: "gating",
  }),
  GATES_STARTED: defineNodeExecutionTransition("GATES_STARTED", {
    allowedFrom: ["running"],
    apply: unchangedNodeState,
    statusAfter: "gating",
  }),
  OUTPUT_RECORDED: defineNodeExecutionTransition("OUTPUT_RECORDED", {
    allowedFrom: ["running"],
    apply: unchangedNodeState,
    statusAfter: "running",
  }),
  PASSED: defineNodeExecutionTransition("PASSED", {
    allowedFrom: ["running", "gating"],
    apply: (state, event) => stateFromResult(state, event.result, event.at),
    statusAfter: "passed",
  }),
  READY: defineNodeExecutionTransition("READY", {
    allowedFrom: ["pending"],
    apply: (state, event) => ({
      ...state,
      startedAt: state.startedAt ?? event.at,
    }),
    statusAfter: "ready",
  }),
  RETRYING: defineNodeExecutionTransition("RETRYING", {
    allowedFrom: ["running", "gating"],
    apply: (state, event) => ({
      ...state,
      attempts: event.attempt,
      evidence: event.evidence,
      retry: event.retry,
    }),
    statusAfter: "running",
  }),
  RUNNER_FINISHED: defineNodeExecutionTransition("RUNNER_FINISHED", {
    allowedFrom: ["running"],
    apply: (state, event) => ({
      ...state,
      evidence: event.evidence,
      exitCode: event.exitCode,
      output: event.output,
    }),
    statusAfter: "running",
  }),
  RUNNER_STARTED: defineNodeExecutionTransition("RUNNER_STARTED", {
    allowedFrom: ["running"],
    apply: unchangedNodeState,
    statusAfter: "running",
  }),
  SKIPPED: defineNodeExecutionTransition("SKIPPED", {
    allowedFrom: ["pending", "ready"],
    apply: (state, event) => ({
      ...state,
      failure: {
        evidence: [event.reason],
        gate: state.id,
        nodeId: state.id,
        reason: event.reason,
      },
      finishedAt: event.at,
    }),
    statusAfter: "skipped",
  }),
  SNAPSHOT_AFTER_FINISHED: defineNodeExecutionTransition("SNAPSHOT_AFTER_FINISHED", {
    allowedFrom: ["running"],
    apply: unchangedNodeState,
    statusAfter: "running",
  }),
  SNAPSHOT_BEFORE_FINISHED: defineNodeExecutionTransition("SNAPSHOT_BEFORE_FINISHED", {
    allowedFrom: ["running"],
    apply: unchangedNodeState,
    statusAfter: "running",
  }),
  STARTED: defineNodeExecutionTransition("STARTED", {
    allowedFrom: ["ready", "running"],
    apply: (state, event) => ({
      ...state,
      attempts: event.attempt,
      startedAt: state.startedAt ?? event.at,
    }),
    statusAfter: "running",
  }),
  START_HOOKS_FINISHED: defineNodeExecutionTransition("START_HOOKS_FINISHED", {
    allowedFrom: ["running"],
    apply: unchangedNodeState,
    statusAfter: "running",
  }),
  SUCCESS_HOOKS_STARTED: defineNodeExecutionTransition("SUCCESS_HOOKS_STARTED", {
    allowedFrom: ["gating"],
    apply: unchangedNodeState,
    statusAfter: "gating",
  }),
};

const applyNodeExecutionEvent = (state: NodeExecutionState, event: NodeExecutionEvent): NodeExecutionState => {
  const transition = nodeExecutionTransitions[event.type];
  assertNodeExecutionTransitionAllowed(state, event, transition);
  return {
    ...transition.apply(state, event),
    status: transition.statusAfter,
  };
};

export class NodeStateTracker {
  private state: NodeExecutionState;

  constructor(nodeId: string, initialState?: NodeExecutionState) {
    this.state = initialState ?? initialNodeExecutionState(nodeId);
  }

  getState(): NodeExecutionState {
    return { ...this.state, gates: [...this.state.gates] };
  }

  record(event: NodeExecutionEvent): NodeExecutionState {
    this.state = applyNodeExecutionEvent(this.state, event);
    return this.getState();
  }
}
