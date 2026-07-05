import { Option } from "effect";

import type { PlannedWorkflowNode } from "../planning/compile";
import type {
  ChangedFilesSnapshot,
  NodeExecutionState,
  RuntimeStructuredOutput,
} from "./contracts";
import type { NodeHandoff } from "./handoff";

interface NodeStateStoreInput {
  handoffByNode?: Map<string, NodeHandoff>;
  inheritedOutputNodeIds?: Set<string>;
  lastOutputByNode?: Map<string, string>;
  nodeSnapshots?: Map<string, ChangedFilesSnapshot>;
  nodeStates?: Map<string, NodeExecutionState>;
  structuredOutputs?: RuntimeStructuredOutput[];
}

const pendingNodeState = (id: string): NodeExecutionState => ({
  attempts: 0,
  evidence: [],
  gates: [],
  id,
  status: "pending",
});

export class NodeStateStore {
  readonly handoffByNode: Map<string, NodeHandoff>;
  readonly inheritedOutputNodeIds: Set<string>;
  readonly lastOutputByNode: Map<string, string>;
  readonly nodeSnapshots: Map<string, ChangedFilesSnapshot>;
  readonly nodeStates: Map<string, NodeExecutionState>;
  readonly structuredOutputs: RuntimeStructuredOutput[];

  // fallow-ignore-next-line complexity
  constructor(input: NodeStateStoreInput = {}) {
    this.handoffByNode = input.handoffByNode ?? new Map<string, NodeHandoff>();
    this.inheritedOutputNodeIds =
      input.inheritedOutputNodeIds ?? new Set<string>();
    this.lastOutputByNode = input.lastOutputByNode ?? new Map<string, string>();
    this.nodeSnapshots =
      input.nodeSnapshots ?? new Map<string, ChangedFilesSnapshot>();
    this.nodeStates = input.nodeStates ?? new Map<string, NodeExecutionState>();
    this.structuredOutputs = input.structuredOutputs ?? [];
  }
  forkForParallelChildren(children: PlannedWorkflowNode[]): NodeStateStore {
    return new NodeStateStore({
      handoffByNode: new Map(this.handoffByNode),
      inheritedOutputNodeIds: new Set(this.lastOutputByNode.keys()),
      lastOutputByNode: new Map(this.lastOutputByNode),
      nodeSnapshots: new Map(),
      nodeStates: new Map(
        children.map((child) => [child.id, pendingNodeState(child.id)])
      ),
      structuredOutputs: this.structuredOutputs,
    });
  }
  getNodeState(nodeId: string): Option.Option<NodeExecutionState> {
    return Option.fromUndefinedOr(this.nodeStates.get(nodeId));
  }
  handoff(nodeId: string): Option.Option<NodeHandoff> {
    return Option.fromUndefinedOr(this.handoffByNode.get(nodeId));
  }
  recordHandoff(nodeId: string, handoff?: NodeHandoff): void {
    if (handoff !== undefined) {
      this.handoffByNode.set(nodeId, handoff);
    }
  }
  recordSessionId(nodeId: string, sessionId: string): void {
    const existing = this.nodeStates.get(nodeId);
    if (existing !== undefined) {
      this.nodeStates.set(nodeId, { ...existing, sessionId });
    }
  }
}

export const initialNodeStateStore = (plan: {
  topologicalOrder: Pick<PlannedWorkflowNode, "id">[];
}): NodeStateStore =>
  new NodeStateStore({
    nodeStates: new Map(
      plan.topologicalOrder.map((node) => [node.id, pendingNodeState(node.id)])
    ),
  });
