import { Effect } from "effect";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { diffChangedFiles } from "../changed-files";
import type {
  ChangedFilesSnapshot,
  NodeAttemptRetry,
  RuntimeContext,
  RuntimeNodeResult,
} from "../contracts";

export interface NodeRemediationResult {
  result?: RuntimeNodeResult;
  retryNode?: boolean;
}

export interface RuntimeRemediationDependencies {
  executeNode: (
    node: PlannedWorkflowNode,
    context: RuntimeContext
  ) => Effect.Effect<RuntimeNodeResult, unknown>;
  isCancelled: (context: RuntimeContext) => boolean;
  snapshotChangedFiles: (
    worktreePath: string
  ) => Effect.Effect<ChangedFilesSnapshot, unknown>;
}

export interface RemediateFailedNodeInput {
  attempt: number;
  context: RuntimeContext;
  dependencies: RuntimeRemediationDependencies;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}

type RemediationStrategy = (
  input: RemediateFailedNodeInput
) => Effect.Effect<NodeRemediationResult | null, unknown>;

const remediationStrategies: RemediationStrategy[] = [
  remediateWritableNodeFailure,
  remediateCoverageFailure,
  remediateUpstreamImplementationFailure,
];

export function remediateFailedNode(
  input: RemediateFailedNodeInput
): Effect.Effect<NodeRemediationResult | null, unknown> {
  return Effect.gen(function* () {
    for (const strategy of remediationStrategies) {
      const result = yield* strategy(input);
      if (result) {
        return result;
      }
    }
    return null;
  });
}

function remediateWritableNodeFailure(
  input: RemediateFailedNodeInput
): Effect.Effect<NodeRemediationResult | null, unknown> {
  return Effect.gen(function* () {
    if (!canSelfRemediateWritableNode(input)) {
      return null;
    }

    const beforeSnapshot = yield* input.dependencies.snapshotChangedFiles(
      input.context.worktreePath
    );
    const beforeOutput = input.context.nodeStateStore.getOutput(input.node.id);
    const result = yield* executeSelfRemediation(input);
    if (result.status !== "passed") {
      return null;
    }

    const changed = diffChangedFiles(
      beforeSnapshot,
      yield* input.dependencies.snapshotChangedFiles(
        input.context.worktreePath
      ),
      input.context.worktreePath
    );
    if (remediationChangedNothing(changed.files.size, result, beforeOutput)) {
      return null;
    }

    input.context.nodeStateStore.setSnapshot(input.node.id, changed);
    input.context.nodeStateStore.recordOutput(input.node.id, result.output);
    return {
      result: {
        attempts: input.attempt + 1,
        evidence: result.evidence,
        exitCode: result.exitCode,
        nodeId: input.node.id,
        output: result.output,
        status: "passed",
      },
    };
  });
}

function canSelfRemediateWritableNode(
  input: RemediateFailedNodeInput
): boolean {
  if (input.retry.retryReason !== "gate_failure") {
    return false;
  }
  if (isRemediationNode(input.node)) {
    return false;
  }
  return nodeCanWrite(input.context, input.node);
}

function remediationChangedNothing(
  changedFileCount: number,
  result: RuntimeNodeResult,
  beforeOutput: string | undefined
): boolean {
  if (changedFileCount !== 0) {
    return false;
  }
  return result.output === beforeOutput;
}

function executeSelfRemediation(
  input: RemediateFailedNodeInput
): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    const node: PlannedWorkflowNode = {
      ...input.node,
      artifacts: undefined,
      dependents: [],
      id: `${input.node.id}:remediate:${input.retry.gate}:${input.attempt}`,
      needs: [],
      retries: undefined,
    };
    return yield* withRemediationTask(
      input.context,
      nodeRemediationTask({
        node: input.node,
        originalTask: input.context.task,
        retry: input.retry,
      }),
      () => input.dependencies.executeNode(node, input.context)
    );
  });
}

function remediateCoverageFailure(
  input: RemediateFailedNodeInput
): Effect.Effect<NodeRemediationResult | null, unknown> {
  if (
    input.retry.retryReason !== "gate_failure" ||
    !hasSchedulingRole(input.context, input.node, "coverage")
  ) {
    return Effect.succeed(null);
  }
  return remediatePassedImplementationAncestors(input).pipe(
    Effect.map(retryNodeWhenRemediated)
  );
}

function remediateUpstreamImplementationFailure(
  input: RemediateFailedNodeInput
): Effect.Effect<NodeRemediationResult | null, unknown> {
  if (
    isRemediationNode(input.node) ||
    nodeCanWrite(input.context, input.node) ||
    hasSchedulingRole(input.context, input.node, "coverage")
  ) {
    return Effect.succeed(null);
  }
  return remediatePassedImplementationAncestors(input).pipe(
    Effect.map(retryNodeWhenRemediated)
  );
}

function retryNodeWhenRemediated(
  remediated: boolean
): NodeRemediationResult | null {
  return remediated ? { retryNode: true } : null;
}

function remediatePassedImplementationAncestors(
  input: RemediateFailedNodeInput
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const implementationNodes = upstreamImplementationNodes(
      input.context,
      input.node
    );
    if (implementationNodes.length === 0) {
      return false;
    }

    // Continue past no-change ancestors; test-only writers may not fix production-code gates.
    let remediated = false;
    for (const implementationNode of implementationNodes) {
      if (yield* remediateImplementationAncestor(input, implementationNode)) {
        remediated = true;
      }
    }
    return remediated;
  });
}

function remediateImplementationAncestor(
  input: RemediateFailedNodeInput,
  implementationNode: PlannedWorkflowNode
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    if (input.dependencies.isCancelled(input.context)) {
      return false;
    }
    const beforeSnapshot = yield* input.dependencies.snapshotChangedFiles(
      input.context.worktreePath
    );
    const beforeOutput = input.context.nodeStateStore.getOutput(
      implementationNode.id
    );
    const result = yield* executeImplementationRemediation({
      attempt: input.attempt,
      context: input.context,
      coverageNode: input.node,
      dependencies: input.dependencies,
      implementationNode,
      retry: input.retry,
    });
    if (result.status !== "passed") {
      return false;
    }
    return yield* recordImplementationRemediationEffect({
      beforeOutput,
      beforeSnapshot,
      context: input.context,
      dependencies: input.dependencies,
      implementationNode,
      result,
    });
  });
}

function recordImplementationRemediationEffect(input: {
  beforeOutput: string | undefined;
  beforeSnapshot: ChangedFilesSnapshot;
  context: RuntimeContext;
  dependencies: RuntimeRemediationDependencies;
  implementationNode: PlannedWorkflowNode;
  result: RuntimeNodeResult;
}): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const changed = diffChangedFiles(
      input.beforeSnapshot,
      yield* input.dependencies.snapshotChangedFiles(
        input.context.worktreePath
      ),
      input.context.worktreePath
    );
    if (
      changed.files.size === 0 &&
      input.result.output === input.beforeOutput
    ) {
      return false;
    }
    input.context.nodeStateStore.recordOutput(
      input.implementationNode.id,
      input.result.output
    );
    return true;
  });
}

function executeImplementationRemediation(input: {
  attempt: number;
  context: RuntimeContext;
  coverageNode: PlannedWorkflowNode;
  dependencies: RuntimeRemediationDependencies;
  implementationNode: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    const node: PlannedWorkflowNode = {
      ...input.implementationNode,
      artifacts: undefined,
      dependents: [],
      gates: undefined,
      id: `${input.implementationNode.id}:remediate:${input.coverageNode.id}:${input.attempt}`,
      needs: [],
      retries: undefined,
    };
    return yield* withRemediationTask(
      input.context,
      implementationRemediationTask({
        coverageNode: input.coverageNode,
        originalTask: input.context.task,
        retry: input.retry,
      }),
      () => input.dependencies.executeNode(node, input.context)
    );
  });
}

function withRemediationTask(
  context: RuntimeContext,
  task: string,
  effect: () => Effect.Effect<RuntimeNodeResult, unknown>
): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    const originalTask = context.task;
    context.task = task;
    return yield* Effect.ensuring(
      effect(),
      Effect.sync(() => {
        context.task = originalTask;
      })
    );
  });
}

function implementationRemediationTask(input: {
  coverageNode: PlannedWorkflowNode;
  originalTask: string;
  retry: NodeAttemptRetry;
}): string {
  return [
    "Remediate a pipeline coverage failure.",
    "",
    "Original task:",
    input.originalTask,
    "",
    "Coverage node:",
    input.coverageNode.id,
    "",
    "Failed gate:",
    input.retry.gate,
    "",
    "Failure reason:",
    input.retry.reason,
    "",
    "Coverage failure feedback:",
    ...input.retry.evidence.map((item) => `- ${item}`),
    "",
    "Update the implementation so the coverage node can pass on its next run.",
  ].join("\n");
}

function nodeRemediationTask(input: {
  node: PlannedWorkflowNode;
  originalTask: string;
  retry: NodeAttemptRetry;
}): string {
  return [
    "Remediate a pipeline node gate failure.",
    "",
    "Original task:",
    input.originalTask,
    "",
    "Node:",
    input.node.id,
    "",
    "Failed gate:",
    input.retry.gate,
    "",
    "Failure reason:",
    input.retry.reason,
    "",
    "Gate failure feedback:",
    ...input.retry.evidence.map((item) => `- ${item}`),
    "",
    "Update the node output and files so this gate can pass.",
  ].join("\n");
}

function upstreamImplementationNodes(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): PlannedWorkflowNode[] {
  const visited = new Set<string>();
  const ordered: PlannedWorkflowNode[] = [];
  const visit = (candidateId: string): void =>
    visitImplementationNode(context, visited, ordered, candidateId, visit);
  for (const need of node.needs) {
    visit(need);
  }
  return ordered;
}

function visitImplementationNode(
  context: RuntimeContext,
  visited: Set<string>,
  ordered: PlannedWorkflowNode[],
  nodeId: string,
  visit: (nodeId: string) => void
): void {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);
  const candidate = context.plan.graph.node(nodeId);
  if (!candidate) {
    return;
  }
  visitImplementationDependencies(candidate, visit);
  appendImplementationNode(context, ordered, candidate);
}

function visitImplementationDependencies(
  candidate: PlannedWorkflowNode,
  visit: (nodeId: string) => void
): void {
  for (const need of candidate.needs) {
    visit(need);
  }
}

function appendImplementationNode(
  context: RuntimeContext,
  ordered: PlannedWorkflowNode[],
  candidate: PlannedWorkflowNode
): void {
  if (!nodeStatePassed(context, candidate.id)) {
    return;
  }
  pushIfImplementation(context, ordered, candidate);
  // Passed parallel nodes imply their forked children passed, but child state is not in this store.
  for (const child of candidate.children ?? []) {
    appendPassedImplementationChild(context, ordered, child);
  }
}

function appendPassedImplementationChild(
  context: RuntimeContext,
  ordered: PlannedWorkflowNode[],
  child: PlannedWorkflowNode
): void {
  pushIfImplementation(context, ordered, child);
  for (const grandchild of child.children ?? []) {
    appendPassedImplementationChild(context, ordered, grandchild);
  }
}

function pushIfImplementation(
  context: RuntimeContext,
  ordered: PlannedWorkflowNode[],
  node: PlannedWorkflowNode
): void {
  if (hasSchedulingRole(context, node, "implementation")) {
    ordered.push(node);
  }
}

function nodeStatePassed(context: RuntimeContext, nodeId: string): boolean {
  return context.nodeStateStore.getNodeState(nodeId)?.status === "passed";
}

function nodeCanWrite(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): boolean {
  const profileId = node.profile;
  if (!profileId) {
    return false;
  }
  return profileCanWrite(context.config.profiles[profileId]);
}

function profileCanWrite(
  profile: RuntimeContext["config"]["profiles"][string] | undefined
): boolean {
  if (!profile) {
    return false;
  }
  return hasWorkspaceWriteMode(profile)
    ? true
    : hasWriteTool(profile.tools ?? []);
}

function hasWorkspaceWriteMode(
  profile: RuntimeContext["config"]["profiles"][string]
): boolean {
  return profile.filesystem?.mode === "workspace-write";
}

function hasWriteTool(tools: string[]): boolean {
  return tools.some(isWriteTool);
}

function isWriteTool(tool: string): boolean {
  return tool === "edit" ? true : tool === "write";
}

function isRemediationNode(node: PlannedWorkflowNode): boolean {
  return node.id.includes(":remediate:");
}

function hasSchedulingRole(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  role: "coverage" | "implementation"
): boolean {
  return node.profile
    ? (context.config.profiles[node.profile]?.scheduling_roles?.includes(
        role
      ) ?? false)
    : false;
}
