import type {
  NodeExecutionState,
  RuntimeContext,
  RuntimeGateResult,
} from "./contracts";

export type ScheduledDependencyOutputs =
  | Map<string, string>
  | Record<string, string>
  | undefined;

export function hydrateDependencyOutputs(
  context: RuntimeContext,
  dependencyOutputs: ScheduledDependencyOutputs
): void {
  const outputs = dependencyOutputMap(dependencyOutputs);
  const finishedAt = now();
  for (const [nodeId, output] of outputs) {
    context.nodeStateStore.recordOutput(nodeId, output);
    context.nodeStateStore.markInheritedOutput(nodeId);
    context.nodeStateStore.setNodeState(
      nodeId,
      inheritedDependencyOutputState(context, nodeId, output, finishedAt)
    );
  }
}

function dependencyOutputMap(
  dependencyOutputs: ScheduledDependencyOutputs
): Map<string, string> {
  if (dependencyOutputs instanceof Map) {
    return dependencyOutputs;
  }
  return new Map(Object.entries(dependencyOutputs ?? {}));
}

function inheritedDependencyOutputState(
  context: RuntimeContext,
  nodeId: string,
  output: string,
  finishedAt: string
): NodeExecutionState {
  const existing = context.nodeStateStore.getNodeState(nodeId);
  return {
    attempts: existingAttempts(existing),
    evidence: inheritedOutputEvidence(existing),
    exitCode: existingExitCode(existing),
    finishedAt: existingFinishedAt(existing, finishedAt),
    gates: existingGates(existing),
    id: nodeId,
    output,
    status: "passed",
  };
}

function existingAttempts(existing: NodeExecutionState | undefined): number {
  return existing ? existing.attempts : 1;
}

function inheritedOutputEvidence(
  existing: NodeExecutionState | undefined
): string[] {
  const evidence = existing ? existing.evidence : [];
  return [...evidence, "dependency output inherited from Argo artifact"];
}

function existingExitCode(existing: NodeExecutionState | undefined): number {
  return existing ? (existing.exitCode ?? 0) : 0;
}

function existingFinishedAt(
  existing: NodeExecutionState | undefined,
  fallback: string
): string {
  return existing ? (existing.finishedAt ?? fallback) : fallback;
}

function existingGates(
  existing: NodeExecutionState | undefined
): RuntimeGateResult[] {
  return existing ? existing.gates : [];
}

export function hydrateScheduledDependencyStates(
  context: RuntimeContext,
  nodeId: string
): void {
  const finishedAt = now();
  for (const dependencyId of scheduledDependencyNodeIds(context, nodeId)) {
    const existing = context.nodeStateStore.getNodeState(dependencyId);
    context.nodeStateStore.setNodeState(
      dependencyId,
      scheduledDependencyState(dependencyId, finishedAt, existing)
    );
  }
}

function scheduledDependencyState(
  id: string,
  finishedAt: string,
  existing?: NodeExecutionState
): NodeExecutionState {
  const base = existing ?? emptyScheduledDependencyState(id);
  return completedScheduledDependencyState(base, finishedAt);
}

function emptyScheduledDependencyState(id: string): NodeExecutionState {
  return {
    attempts: 0,
    evidence: [],
    gates: [],
    id,
    status: "pending",
  };
}

function completedScheduledDependencyState(
  base: NodeExecutionState,
  finishedAt: string
): NodeExecutionState {
  return {
    ...base,
    attempts: positiveAttempts(base),
    evidence: dependencyEvidence(base),
    exitCode: base.exitCode ?? 0,
    finishedAt: base.finishedAt ?? finishedAt,
    output: base.output ?? "",
    status: "passed",
  };
}

function positiveAttempts(state: NodeExecutionState): number {
  return state.attempts > 0 ? state.attempts : 1;
}

function dependencyEvidence(state: NodeExecutionState): string[] {
  return state.evidence.length > 0
    ? state.evidence
    : ["dependency satisfied by scheduled workflow"];
}

function scheduledDependencyNodeIds(
  context: RuntimeContext,
  nodeId: string
): string[] {
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (candidateId: string): void => {
    if (visited.has(candidateId)) {
      return;
    }
    visited.add(candidateId);
    const candidate = context.plan.graph.node(candidateId);
    if (!candidate) {
      return;
    }
    for (const need of candidate.needs) {
      visit(need);
    }
    ordered.push(candidateId);
  };
  const node = context.plan.graph.node(nodeId);
  for (const need of node?.needs ?? []) {
    visit(need);
  }
  return ordered;
}

function now(): string {
  return new Date().toISOString();
}
