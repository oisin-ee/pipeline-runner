import { getOrUndefined, match, none, some } from "effect/Option";
import type { Option } from "effect/Option";

import type {
  NodeExecutionState,
  RuntimeContext,
  RuntimeGateResult,
} from "./contracts";

export type ScheduledDependencyOutputs =
  | Map<string, string>
  | Record<string, string>
  | void;

type PresentScheduledDependencyOutputs = Exclude<
  ScheduledDependencyOutputs,
  void
>;

const dependencyOutputsOption = (
  dependencyOutputs: ScheduledDependencyOutputs
): Option<PresentScheduledDependencyOutputs> =>
  dependencyOutputs === undefined ? none() : some(dependencyOutputs);

const dependencyOutputMap = (
  dependencyOutputs: ScheduledDependencyOutputs
): Map<string, string> =>
  match(dependencyOutputsOption(dependencyOutputs), {
    onNone: () => new Map(),
    onSome: (outputs) =>
      outputs instanceof Map ? outputs : new Map(Object.entries(outputs)),
  });

const existingAttempts = (existing?: NodeExecutionState): number =>
  existing ? existing.attempts : 1;

const inheritedOutputEvidence = (existing?: NodeExecutionState): string[] => {
  const evidence = existing ? existing.evidence : [];
  return [...evidence, "dependency output inherited from Argo artifact"];
};

const existingExitCode = (existing?: NodeExecutionState): number =>
  existing ? (existing.exitCode ?? 0) : 0;

const existingFinishedAt = (
  fallback: string,
  existing?: NodeExecutionState
): string => (existing ? (existing.finishedAt ?? fallback) : fallback);

const existingGates = (existing?: NodeExecutionState): RuntimeGateResult[] =>
  existing ? existing.gates : [];

const inheritedDependencyOutputState = (
  context: RuntimeContext,
  nodeId: string,
  output: string,
  finishedAt: string
): NodeExecutionState => {
  const existing = getOrUndefined(context.nodeStateStore.getNodeState(nodeId));
  return {
    attempts: existingAttempts(existing),
    evidence: inheritedOutputEvidence(existing),
    exitCode: existingExitCode(existing),
    finishedAt: existingFinishedAt(finishedAt, existing),
    gates: existingGates(existing),
    id: nodeId,
    output,
    status: "passed",
  };
};

const emptyScheduledDependencyState = (id: string): NodeExecutionState => ({
  attempts: 0,
  evidence: [],
  gates: [],
  id,
  status: "pending",
});

const positiveAttempts = (state: NodeExecutionState): number =>
  state.attempts > 0 ? state.attempts : 1;

const dependencyEvidence = (state: NodeExecutionState): string[] =>
  state.evidence.length > 0
    ? state.evidence
    : ["dependency satisfied by scheduled workflow"];

const completedScheduledDependencyState = (
  base: NodeExecutionState,
  finishedAt: string
): NodeExecutionState => ({
  ...base,
  attempts: positiveAttempts(base),
  evidence: dependencyEvidence(base),
  exitCode: base.exitCode ?? 0,
  finishedAt: base.finishedAt ?? finishedAt,
  output: base.output ?? "",
  status: "passed",
});

const scheduledDependencyState = (
  id: string,
  finishedAt: string,
  existing?: NodeExecutionState
): NodeExecutionState => {
  const base = existing ?? emptyScheduledDependencyState(id);
  return completedScheduledDependencyState(base, finishedAt);
};

const scheduledDependencyNodeIds = (
  context: RuntimeContext,
  nodeId: string
): string[] => {
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (candidateId: string): void => {
    if (visited.has(candidateId)) {
      return;
    }
    visited.add(candidateId);
    if (!context.plan.graph.hasNode(candidateId)) {
      return;
    }
    const candidate = context.plan.graph.node(candidateId);
    for (const need of candidate.needs) {
      visit(need);
    }
    ordered.push(candidateId);
  };
  if (!context.plan.graph.hasNode(nodeId)) {
    return ordered;
  }
  const node = context.plan.graph.node(nodeId);
  for (const need of node.needs) {
    visit(need);
  }
  return ordered;
};

const now = (): string => new Date().toISOString();

export const hydrateDependencyOutputs = (
  context: RuntimeContext,
  dependencyOutputs: ScheduledDependencyOutputs
): void => {
  const outputs = dependencyOutputMap(dependencyOutputs);
  const finishedAt = now();
  for (const [nodeId, output] of outputs) {
    context.nodeStateStore.lastOutputByNode.set(nodeId, output);
    context.nodeStateStore.inheritedOutputNodeIds.add(nodeId);
    context.nodeStateStore.nodeStates.set(
      nodeId,
      inheritedDependencyOutputState(context, nodeId, output, finishedAt)
    );
  }
};

export const hydrateScheduledDependencyStates = (
  context: RuntimeContext,
  nodeId: string
): void => {
  const finishedAt = now();
  for (const dependencyId of scheduledDependencyNodeIds(context, nodeId)) {
    const existing = getOrUndefined(
      context.nodeStateStore.getNodeState(dependencyId)
    );
    context.nodeStateStore.nodeStates.set(
      dependencyId,
      scheduledDependencyState(dependencyId, finishedAt, existing)
    );
  }
};
