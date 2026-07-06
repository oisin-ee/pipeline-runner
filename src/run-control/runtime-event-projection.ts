import type { PipelineRuntimeEvent } from "../pipeline-runtime";
import type { MokaNodeStatus, MokaRunStatus } from "./contracts";

export interface RuntimeEventProjectionState {
  activeHookPreviousStatuses: ReadonlyMap<string, MokaNodeStatus>;
  observedNodeStatuses: ReadonlyMap<string, MokaNodeStatus>;
}

export type RuntimeEventStoreWriteIntent =
  | {
      status: MokaRunStatus;
      type: "run.status";
    }
  | {
      nodeId: string;
      status: MokaNodeStatus;
      type: "node.status";
    }
  | {
      nodeId: string;
      sessionId: string;
      type: "node.session";
    };

export interface RuntimeEventProjection {
  state: RuntimeEventProjectionState;
  writes: RuntimeEventStoreWriteIntent[];
}

interface MutableProjectionState {
  activeHookPreviousStatuses: Map<string, MokaNodeStatus>;
  observedNodeStatuses: Map<string, MokaNodeStatus>;
}

type RuntimeEventType = PipelineRuntimeEvent["type"];
type RuntimeEventOf<Type extends RuntimeEventType> = Extract<PipelineRuntimeEvent, { type: Type }>;
type ProjectionHandler<Type extends RuntimeEventType> = (
  event: RuntimeEventOf<Type>,
  state: MutableProjectionState,
) => RuntimeEventStoreWriteIntent[];
type AnyProjectionHandler = (
  event: PipelineRuntimeEvent,
  state: MutableProjectionState,
) => RuntimeEventStoreWriteIntent[];

const WORKFLOW_OUTCOME_STATUSES: Record<RuntimeEventOf<"workflow.finish">["outcome"], MokaRunStatus> = {
  CANCELLED: "aborted",
  FAIL: "failed",
  PASS: "passed",
};

const NODE_FINISH_STATUSES: Record<RuntimeEventOf<"node.finish">["status"], MokaNodeStatus> = {
  failed: "failed",
  passed: "passed",
};

const noStoreWriteHandler: AnyProjectionHandler = () => [];

export const createRuntimeEventProjectionState = (): RuntimeEventProjectionState => ({
  activeHookPreviousStatuses: new Map(),
  observedNodeStatuses: new Map(),
});

const isRuntimeEventOfType = <Type extends RuntimeEventType>(
  event: PipelineRuntimeEvent,
  type: Type,
): event is RuntimeEventOf<Type> => event.type === type;

const eventHandler =
  <Type extends RuntimeEventType>(type: Type, handler: ProjectionHandler<Type>): AnyProjectionHandler =>
  (event, state) => {
    if (!isRuntimeEventOfType(event, type)) {
      throw new Error(`Projection handler mismatch for event type ${type}`);
    }
    return handler(event, state);
  };

const nodeStatusIntent = (
  state: MutableProjectionState,
  nodeId: string,
  status: MokaNodeStatus,
): RuntimeEventStoreWriteIntent[] => {
  state.observedNodeStatuses.set(nodeId, status);
  return [
    {
      nodeId,
      status,
      type: "node.status",
    },
  ];
};

const projectHookStart = (
  event: RuntimeEventOf<"hook.start">,
  state: MutableProjectionState,
): RuntimeEventStoreWriteIntent[] => {
  if (event.nodeId === undefined || event.nodeId.length === 0) {
    return [];
  }

  const previous = state.observedNodeStatuses.get(event.nodeId);
  if (previous) {
    state.activeHookPreviousStatuses.set(event.hookId, previous);
  }

  return nodeStatusIntent(state, event.nodeId, "running");
};

const projectHookFinish = (
  event: RuntimeEventOf<"hook.finish">,
  state: MutableProjectionState,
): RuntimeEventStoreWriteIntent[] => {
  if (event.nodeId === undefined || event.nodeId.length === 0) {
    return [];
  }

  const previousStatus = state.activeHookPreviousStatuses.get(event.hookId);
  state.activeHookPreviousStatuses.delete(event.hookId);

  if (!event.passed && event.required) {
    return nodeStatusIntent(state, event.nodeId, "blocked");
  }

  return nodeStatusIntent(state, event.nodeId, previousStatus ?? "running");
};

const cloneProjectionState = (state: RuntimeEventProjectionState): MutableProjectionState => ({
  activeHookPreviousStatuses: new Map(state.activeHookPreviousStatuses),
  observedNodeStatuses: new Map(state.observedNodeStatuses),
});

const agentFinishStatus = (exitCode: number): MokaNodeStatus => (exitCode === 0 ? "running" : "failed");

const EVENT_PROJECTION_HANDLERS: Record<RuntimeEventType, AnyProjectionHandler> = {
  "agent.finish": eventHandler("agent.finish", (event, state) =>
    nodeStatusIntent(state, event.nodeId, agentFinishStatus(event.exitCode)),
  ),
  "agent.start": eventHandler("agent.start", (event, state) => nodeStatusIntent(state, event.nodeId, "running")),
  "artifact.check.finish": noStoreWriteHandler,
  "artifact.check.start": noStoreWriteHandler,
  "delivery.pull-request": noStoreWriteHandler,
  "gate.finish": eventHandler("gate.finish", (event, state) =>
    nodeStatusIntent(state, event.nodeId, event.passed ? "running" : "blocked"),
  ),
  "gate.start": eventHandler("gate.start", (event, state) => nodeStatusIntent(state, event.nodeId, "running")),
  "hook.finish": eventHandler("hook.finish", projectHookFinish),
  "hook.result": noStoreWriteHandler,
  "hook.start": eventHandler("hook.start", projectHookStart),
  "node.finish": eventHandler("node.finish", (event, state) =>
    nodeStatusIntent(state, event.nodeId, NODE_FINISH_STATUSES[event.status]),
  ),
  "node.output.recorded": noStoreWriteHandler,
  "node.session": eventHandler("node.session", (event) => [
    {
      nodeId: event.nodeId,
      sessionId: event.sessionId,
      type: "node.session",
    },
  ]),
  "node.start": eventHandler("node.start", (event, state) => nodeStatusIntent(state, event.nodeId, "running")),
  "output.repair": noStoreWriteHandler,
  "runtime.observability": noStoreWriteHandler,
  "workflow.finish": eventHandler("workflow.finish", (event) => [
    {
      status: WORKFLOW_OUTCOME_STATUSES[event.outcome],
      type: "run.status",
    },
  ]),
  "workflow.planned": noStoreWriteHandler,
  "workflow.start": eventHandler("workflow.start", () => [
    {
      status: "starting",
      type: "run.status",
    },
  ]),
};

const projectRuntimeEventWrites = (
  event: PipelineRuntimeEvent,
  state: MutableProjectionState,
): RuntimeEventStoreWriteIntent[] => EVENT_PROJECTION_HANDLERS[event.type](event, state);

export const projectRuntimeEvent = (
  event: PipelineRuntimeEvent,
  state: RuntimeEventProjectionState,
): RuntimeEventProjection => {
  const nextState = cloneProjectionState(state);

  return {
    state: nextState,
    writes: projectRuntimeEventWrites(event, nextState),
  };
};
