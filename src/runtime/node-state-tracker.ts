import type { RetryReason } from "./actor-ids";
import type {
  NodeExecutionState,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
} from "./contracts";
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

function initialNodeExecutionState(nodeId: string): NodeExecutionState {
  return {
    attempts: 0,
    evidence: [],
    gates: [],
    id: nodeId,
    status: "pending",
  };
}

type NodeExecutionEventHandler<T extends NodeExecutionEvent["type"]> = (
  state: NodeExecutionState,
  event: Extract<NodeExecutionEvent, { type: T }>
) => NodeExecutionState;

type NodeExecutionEventHandlers = {
  [K in NodeExecutionEvent["type"]]: NodeExecutionEventHandler<K>;
};

const unchangedNodeState = (state: NodeExecutionState): NodeExecutionState =>
  state;

const nodeExecutionEventHandlers: NodeExecutionEventHandlers = {
  CANCELLED: (state, event) => ({
    ...state,
    failure: event.failure,
    finishedAt: event.at,
    status: "cancelled",
  }),
  FAILED: (state, event) => ({
    ...stateFromResult(state, event.result, event.at, "failed"),
    failure: event.failure,
  }),
  GATES_FINISHED: (state, event) => ({ ...state, gates: event.gates }),
  GATES_STARTED: (state) => ({ ...state, status: "gating" }),
  OUTPUT_RECORDED: unchangedNodeState,
  PASSED: (state, event) =>
    stateFromResult(state, event.result, event.at, "passed"),
  READY: (state, event) => ({
    ...state,
    startedAt: state.startedAt ?? event.at,
    status: state.status === "pending" ? "ready" : state.status,
  }),
  RETRYING: (state, event) => ({
    ...state,
    attempts: event.attempt,
    evidence: event.evidence,
    retry: event.retry,
    status: "running",
  }),
  RUNNER_FINISHED: (state, event) => ({
    ...state,
    evidence: event.evidence,
    exitCode: event.exitCode,
    output: event.output,
    status: "running",
  }),
  RUNNER_STARTED: unchangedNodeState,
  SKIPPED: (state, event) => ({
    ...state,
    failure: {
      evidence: [event.reason],
      gate: state.id,
      nodeId: state.id,
      reason: event.reason,
    },
    finishedAt: event.at,
    status: "skipped",
  }),
  SNAPSHOT_AFTER_FINISHED: unchangedNodeState,
  SNAPSHOT_BEFORE_FINISHED: unchangedNodeState,
  STARTED: (state, event) => ({
    ...state,
    attempts: event.attempt,
    startedAt: state.startedAt ?? event.at,
    status: "running",
  }),
  START_HOOKS_FINISHED: unchangedNodeState,
  SUCCESS_HOOKS_STARTED: unchangedNodeState,
};

function applyNodeExecutionEvent(
  state: NodeExecutionState,
  event: NodeExecutionEvent
): NodeExecutionState {
  const handler = nodeExecutionEventHandlers[event.type] as (
    state: NodeExecutionState,
    event: NodeExecutionEvent
  ) => NodeExecutionState;
  return handler(state, event);
}

function stateFromResult(
  state: NodeExecutionState,
  result: RuntimeNodeResult,
  at: string,
  status: "failed" | "passed"
): NodeExecutionState {
  return {
    ...state,
    attempts: result.attempts,
    evidence: result.evidence,
    exitCode: result.exitCode,
    finishedAt: at,
    output: result.output,
    status,
  };
}
