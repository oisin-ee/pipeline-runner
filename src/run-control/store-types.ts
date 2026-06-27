import type {
  MokaNodeStatus,
  MokaRunControlEvent,
  MokaRunController,
  MokaRunStatus,
  RunControlStaleDetection,
  RunEffort,
  RunMode,
  RunTarget,
} from "./contracts";

export interface StoreContext {
  workspaceRoot: string;
}

export interface CreateRunInput extends StoreContext {
  effort: RunEffort;
  mode: RunMode;
  nodeIds: string[];
  runId: string;
  schedule?: string;
  staleDetection?: RunControlStaleDetection;
  target: RunTarget;
}

export interface ReadRunInput extends StoreContext {
  runId: string;
}

export interface RunControlStatusPaths {
  events: string;
  manifest: string;
  status: string;
}

export interface RecordEventInput extends StoreContext {
  event: MokaRunControlEvent;
  runId: string;
}

export interface UpdateRunControllerInput extends StoreContext {
  controller: MokaRunController;
  runId: string;
}

export interface UpdateRunStatusInput extends StoreContext {
  at: string;
  runId: string;
  status: MokaRunStatus;
}

export interface UpdateNodeStatusInput extends StoreContext {
  at: string;
  nodeId: string;
  runId: string;
  status: MokaNodeStatus;
}

export interface UpdateNodeSessionInput extends StoreContext {
  nodeId: string;
  runId: string;
  sessionId: string;
}

export interface WriteNodeArtifactInput extends StoreContext {
  content: string;
  contentType?: string;
  name: string;
  nodeId: string;
  runId: string;
}

export interface NodeArtifactReference {
  path: string;
}

export interface RunStatusFile {
  nodes: Record<string, RunStatusNode>;
  status: MokaRunStatus;
}

export type RunStatusNode =
  | MokaNodeStatus
  | {
      sessionId?: string;
      status: MokaNodeStatus;
    };
