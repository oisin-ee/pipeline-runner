import type { PlannedWorkflowNode } from "../planning/compile";
import type {
  ChangedFilesSnapshot,
  NodeExecutionState,
  RuntimeStructuredOutput,
} from "./contracts";

export class NodeStateStore {
  readonly inheritedOutputNodeIds: Set<string>;
  readonly lastOutputByNode: Map<string, string>;
  readonly nodeSnapshots: Map<string, ChangedFilesSnapshot>;
  readonly nodeStates: Map<string, NodeExecutionState>;
  readonly structuredOutputs: RuntimeStructuredOutput[];

  constructor(input: NodeStateStoreInput = {}) {
    this.inheritedOutputNodeIds = input.inheritedOutputNodeIds ?? new Set();
    this.lastOutputByNode = input.lastOutputByNode ?? new Map();
    this.nodeSnapshots = input.nodeSnapshots ?? new Map();
    this.nodeStates = input.nodeStates ?? new Map();
    this.structuredOutputs = input.structuredOutputs ?? [];
  }

  // fallow-ignore-next-line unused-class-member
  forkForParallelChildren(children: PlannedWorkflowNode[]): NodeStateStore {
    return new NodeStateStore({
      inheritedOutputNodeIds: new Set(this.lastOutputByNode.keys()),
      lastOutputByNode: new Map(this.lastOutputByNode),
      nodeSnapshots: new Map(),
      nodeStates: new Map(
        children.map((child) => [child.id, pendingNodeState(child.id)])
      ),
      structuredOutputs: this.structuredOutputs,
    });
  }

  // fallow-ignore-next-line unused-class-member
  changedFiles(nodeId: string): string[] {
    const snapshot = this.nodeSnapshots.get(nodeId);
    return snapshot ? [...snapshot.files] : [];
  }

  // fallow-ignore-next-line unused-class-member
  changedFilesForAllNodes(): string[] {
    return [...this.nodeSnapshots.values()].flatMap((snapshot) => [
      ...snapshot.files,
    ]);
  }

  // fallow-ignore-next-line unused-class-member
  getNodeState(nodeId: string): NodeExecutionState | undefined {
    return this.nodeStates.get(nodeId);
  }

  // fallow-ignore-next-line unused-class-member
  getOutput(nodeId: string): string | undefined {
    return this.lastOutputByNode.get(nodeId);
  }

  // fallow-ignore-next-line unused-class-member
  outputText(nodeId: string): string {
    return this.lastOutputByNode.get(nodeId) ?? "";
  }

  // fallow-ignore-next-line unused-class-member
  getSnapshot(nodeId: string): ChangedFilesSnapshot | undefined {
    return this.nodeSnapshots.get(nodeId);
  }

  // fallow-ignore-next-line unused-class-member
  inheritedOutputIdsExcluding(nodeIds: Iterable<string>): string[] {
    const excluded = new Set(nodeIds);
    return [...this.inheritedOutputNodeIds].filter(
      (id) => !excluded.has(id) && this.lastOutputByNode.has(id)
    );
  }

  // fallow-ignore-next-line unused-class-member
  markInheritedOutput(nodeId: string): void {
    this.inheritedOutputNodeIds.add(nodeId);
  }

  // fallow-ignore-next-line unused-class-member
  recordOutput(nodeId: string, output: string): void {
    this.lastOutputByNode.set(nodeId, output);
  }

  // fallow-ignore-next-line unused-class-member
  recordSessionId(nodeId: string, sessionId: string): void {
    const existing = this.nodeStates.get(nodeId);
    if (existing) {
      this.nodeStates.set(nodeId, { ...existing, sessionId });
    }
  }

  // fallow-ignore-next-line unused-class-member
  recordStructuredOutput(output: RuntimeStructuredOutput): void {
    this.structuredOutputs.push(output);
  }

  // fallow-ignore-next-line unused-class-member
  setNodeState(nodeId: string, state: NodeExecutionState): void {
    this.nodeStates.set(nodeId, state);
  }

  // fallow-ignore-next-line unused-class-member
  setSnapshot(nodeId: string, snapshot: ChangedFilesSnapshot): void {
    this.nodeSnapshots.set(nodeId, snapshot);
  }

  // fallow-ignore-next-line unused-class-member
  toNodeStateRecord(): Record<string, NodeExecutionState> {
    return Object.fromEntries(this.nodeStates);
  }

  // fallow-ignore-next-line unused-class-member
  structuredOutputList(): RuntimeStructuredOutput[] {
    return [...this.structuredOutputs];
  }
}

interface NodeStateStoreInput {
  inheritedOutputNodeIds?: Set<string>;
  lastOutputByNode?: Map<string, string>;
  nodeSnapshots?: Map<string, ChangedFilesSnapshot>;
  nodeStates?: Map<string, NodeExecutionState>;
  structuredOutputs?: RuntimeStructuredOutput[];
}

export function initialNodeStateStore(plan: {
  topologicalOrder: Pick<PlannedWorkflowNode, "id">[];
}): NodeStateStore {
  return new NodeStateStore({
    nodeStates: new Map(
      plan.topologicalOrder.map((node) => [node.id, pendingNodeState(node.id)])
    ),
  });
}

function pendingNodeState(id: string): NodeExecutionState {
  return {
    attempts: 0,
    evidence: [],
    gates: [],
    id,
    status: "pending",
  };
}
