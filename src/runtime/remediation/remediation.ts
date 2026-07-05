import { Effect, Option } from "effect";

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
) => Effect.Effect<Option.Option<NodeRemediationResult>, unknown>;

const remediationChangedNothing = (
  changedFileCount: number,
  result: RuntimeNodeResult,
  beforeOutput?: string
): boolean => {
  if (changedFileCount !== 0) {
    return false;
  }
  return result.output === beforeOutput;
};

const retryNodeWhenRemediated = (
  remediated: boolean
): Option.Option<NodeRemediationResult> =>
  remediated ? Option.some({ retryNode: true }) : Option.none();

const recordImplementationRemediationEffect = (input: {
  beforeOutput?: string;
  beforeSnapshot: ChangedFilesSnapshot;
  context: RuntimeContext;
  dependencies: RuntimeRemediationDependencies;
  implementationNode: PlannedWorkflowNode;
  result: RuntimeNodeResult;
}): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* effectBody() {
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

const withRemediationTask = (
  context: RuntimeContext,
  task: string,
  effect: () => Effect.Effect<RuntimeNodeResult, unknown>
): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
    const originalTask = context.task;
    context.task = task;
    return yield* Effect.ensuring(
      effect(),
      Effect.sync(() => {
        context.task = originalTask;
      })
    );
  });

const implementationRemediationTask = (input: {
  coverageNode: PlannedWorkflowNode;
  originalTask: string;
  retry: NodeAttemptRetry;
}): string =>
  [
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

const executeImplementationRemediation = (input: {
  attempt: number;
  context: RuntimeContext;
  coverageNode: PlannedWorkflowNode;
  dependencies: RuntimeRemediationDependencies;
  implementationNode: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
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

const remediateImplementationAncestor = (
  input: RemediateFailedNodeInput,
  implementationNode: PlannedWorkflowNode
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* effectBody() {
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
      beforeOutput: Option.getOrUndefined(beforeOutput),
      beforeSnapshot,
      context: input.context,
      dependencies: input.dependencies,
      implementationNode,
      result,
    });
  });

const nodeRemediationTask = (input: {
  node: PlannedWorkflowNode;
  originalTask: string;
  retry: NodeAttemptRetry;
}): string =>
  [
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

const executeSelfRemediation = (
  input: RemediateFailedNodeInput
): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
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

const visitImplementationDependencies = (
  candidate: PlannedWorkflowNode,
  visit: (nodeId: string) => void
): void => {
  for (const need of candidate.needs) {
    visit(need);
  }
};

const nodeStatePassed = (context: RuntimeContext, nodeId: string): boolean =>
  Option.match(context.nodeStateStore.getNodeState(nodeId), {
    onNone: () => false,
    onSome: (state) => state.status === "passed",
  });

const hasWorkspaceWriteMode = (
  profile: RuntimeContext["config"]["profiles"][string]
): boolean => profile.filesystem?.mode === "workspace-write";

const isWriteTool = (tool: string): boolean =>
  tool === "edit" ? true : tool === "write";

const hasWriteTool = (tools: string[]): boolean => tools.some(isWriteTool);

const profileCanWrite = (
  profile?: RuntimeContext["config"]["profiles"][string]
): boolean => {
  if (!profile) {
    return false;
  }
  return hasWorkspaceWriteMode(profile)
    ? true
    : hasWriteTool(profile.tools ?? []);
};

const nodeCanWrite = (
  context: RuntimeContext,
  node: PlannedWorkflowNode
): boolean => {
  const profileId = node.profile;
  if (profileId === undefined || profileId.length === 0) {
    return false;
  }
  return profileCanWrite(context.config.profiles[profileId]);
};

const isRemediationNode = (node: PlannedWorkflowNode): boolean =>
  node.id.includes(":remediate:");

const canSelfRemediateWritableNode = (
  input: RemediateFailedNodeInput
): boolean => {
  if (input.retry.retryReason !== "gate_failure") {
    return false;
  }
  if (isRemediationNode(input.node)) {
    return false;
  }
  return nodeCanWrite(input.context, input.node);
};

const remediateWritableNodeFailure = (
  input: RemediateFailedNodeInput
): Effect.Effect<Option.Option<NodeRemediationResult>, unknown> =>
  Effect.gen(function* effectBody() {
    if (!canSelfRemediateWritableNode(input)) {
      return Option.none();
    }

    const beforeSnapshot = yield* input.dependencies.snapshotChangedFiles(
      input.context.worktreePath
    );
    const beforeOutput = input.context.nodeStateStore.getOutput(input.node.id);
    const result = yield* executeSelfRemediation(input);
    if (result.status !== "passed") {
      return Option.none();
    }

    const changed = diffChangedFiles(
      beforeSnapshot,
      yield* input.dependencies.snapshotChangedFiles(
        input.context.worktreePath
      ),
      input.context.worktreePath
    );
    if (
      remediationChangedNothing(
        changed.files.size,
        result,
        Option.getOrUndefined(beforeOutput)
      )
    ) {
      return Option.none();
    }

    input.context.nodeStateStore.setSnapshot(input.node.id, changed);
    input.context.nodeStateStore.recordOutput(input.node.id, result.output);
    return Option.some({
      result: {
        attempts: input.attempt + 1,
        evidence: result.evidence,
        exitCode: result.exitCode,
        nodeId: input.node.id,
        output: result.output,
        status: "passed",
      },
    });
  });

const hasSchedulingRole = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  role: "coverage" | "implementation"
): boolean =>
  node.profile === undefined || node.profile.length === 0
    ? false
    : (context.config.profiles[node.profile]?.scheduling_roles?.includes(
        role
      ) ?? false);

const pushIfImplementation = (
  context: RuntimeContext,
  ordered: PlannedWorkflowNode[],
  node: PlannedWorkflowNode
): void => {
  if (hasSchedulingRole(context, node, "implementation")) {
    ordered.push(node);
  }
};

const appendPassedImplementationChild = (
  context: RuntimeContext,
  ordered: PlannedWorkflowNode[],
  child: PlannedWorkflowNode
): void => {
  pushIfImplementation(context, ordered, child);
  for (const grandchild of child.children ?? []) {
    appendPassedImplementationChild(context, ordered, grandchild);
  }
};

const appendImplementationNode = (
  context: RuntimeContext,
  ordered: PlannedWorkflowNode[],
  candidate: PlannedWorkflowNode
): void => {
  if (!nodeStatePassed(context, candidate.id)) {
    return;
  }
  pushIfImplementation(context, ordered, candidate);
  // Passed parallel nodes imply their forked children passed, but child state is not in this store.
  for (const child of candidate.children ?? []) {
    appendPassedImplementationChild(context, ordered, child);
  }
};

const visitImplementationNode = (
  context: RuntimeContext,
  visited: Set<string>,
  ordered: PlannedWorkflowNode[],
  nodeId: string,
  visit: (nodeId: string) => void
): void => {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);
  if (!context.plan.graph.hasNode(nodeId)) {
    return;
  }
  const candidate = context.plan.graph.node(nodeId);
  visitImplementationDependencies(candidate, visit);
  appendImplementationNode(context, ordered, candidate);
};

const upstreamImplementationNodes = (
  context: RuntimeContext,
  node: PlannedWorkflowNode
): PlannedWorkflowNode[] => {
  const visited = new Set<string>();
  const ordered: PlannedWorkflowNode[] = [];
  const visit = (candidateId: string): void => {
    visitImplementationNode(context, visited, ordered, candidateId, visit);
  };
  for (const need of node.needs) {
    visit(need);
  }
  return ordered;
};

const remediatePassedImplementationAncestors = (
  input: RemediateFailedNodeInput
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* effectBody() {
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

const remediateCoverageFailure = (
  input: RemediateFailedNodeInput
): Effect.Effect<Option.Option<NodeRemediationResult>, unknown> => {
  if (
    input.retry.retryReason !== "gate_failure" ||
    !hasSchedulingRole(input.context, input.node, "coverage")
  ) {
    return Effect.succeed(Option.none());
  }
  return remediatePassedImplementationAncestors(input).pipe(
    Effect.map(retryNodeWhenRemediated)
  );
};

const remediateUpstreamImplementationFailure = (
  input: RemediateFailedNodeInput
): Effect.Effect<Option.Option<NodeRemediationResult>, unknown> => {
  if (
    isRemediationNode(input.node) ||
    nodeCanWrite(input.context, input.node) ||
    hasSchedulingRole(input.context, input.node, "coverage")
  ) {
    return Effect.succeed(Option.none());
  }
  return remediatePassedImplementationAncestors(input).pipe(
    Effect.map(retryNodeWhenRemediated)
  );
};

const remediationStrategies: RemediationStrategy[] = [
  remediateWritableNodeFailure,
  remediateCoverageFailure,
  remediateUpstreamImplementationFailure,
];

export const remediateFailedNode = (
  input: RemediateFailedNodeInput
): Effect.Effect<Option.Option<NodeRemediationResult>, unknown> =>
  Effect.gen(function* effectBody() {
    for (const strategy of remediationStrategies) {
      const result = yield* strategy(input);
      if (Option.isSome(result)) {
        return result;
      }
    }
    return Option.none();
  });
