import { createActor, waitFor } from "xstate";
import type { PipelineConfigError } from "./config";
import { effectiveTaskContext, executeAgentNode } from "./runtime/agent-node";
import { executeBuiltin } from "./runtime/builtins";
import {
  diffChangedFiles,
  snapshotChangedFiles,
} from "./runtime/changed-files";
import { executeCommand } from "./runtime/command-executor";
import {
  createRuntimeContext,
  planContainsWorktreeBackedWorkflowNode,
} from "./runtime/context";
import type {
  NodeAttemptCycleResult,
  NodeAttemptResult,
  NodeAttemptRetry,
  NodeExecutionState,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./runtime/contracts";
import {
  childReporter,
  emit,
  emitNodeFinish,
  emitNodeOutputRecorded,
  emitNodeStart,
  emitWorkflowFinish,
  emitWorkflowPlanned,
  runtimeInspection,
  runtimeNodeActorDescriptor,
  runtimeSystemId,
} from "./runtime/events";
import { evaluateNodeGates } from "./runtime/gates";
import { dispatchHooks } from "./runtime/hooks";
import { parseJsonObject } from "./runtime/json-validation";
import { executeParallelNode } from "./runtime/parallel-node";
import {
  commitWorkflowNodeWorktree,
  prepareWorkflowNodeWorktree,
  removeWorkflowNodeWorktree,
  workflowBaseSha,
} from "./runtime/worktrees";
import {
  type NodeRetryPolicyContract,
  type RetryReason,
  runtimeActorId,
} from "./runtime-machines/contracts";
import {
  type NodeExecutionActor,
  nodeExecutionMachine,
} from "./runtime-machines/node-machine";
import {
  type WorkflowSchedulerActor,
  workflowSchedulerMachine,
} from "./runtime-machines/workflow-machine";
import type { PlannedWorkflowNode } from "./workflow-planner";

export type {
  AcceptanceCriterion,
  HookRuntimePolicy,
  NodeExecutionState,
  NodeStatus,
  PipelineRuntimeEvent,
  PipelineRuntimeObservabilityLevel,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  PipelineTaskContext,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./runtime/contracts";
export function runPipelineFromConfig(
  options: PipelineRuntimeOptions
): Promise<PipelineRuntimeResult> {
  const context = createRuntimeContext(options);
  return runPipelineWithContext(context);
}

async function runPipelineWithContext(
  context: RuntimeContext
): Promise<PipelineRuntimeResult> {
  await pinWorkflowBaseSha(context);
  const workflowActor = startWorkflowSchedulerActor(context);
  const snapshot = await waitFor(
    workflowActor,
    (state) => state.status === "done"
  );
  const result = snapshot.context.result;
  if (!result) {
    throw new Error("workflow scheduler finished without a runtime result");
  }
  workflowActor.stop();
  return finishRuntime(context, result);
}

function startWorkflowSchedulerActor(
  context: RuntimeContext
): WorkflowSchedulerActor {
  const systemId = runtimeSystemId(context);
  const actor = createActor(workflowSchedulerMachine, {
    id: runtimeActorId("workflow", {
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    systemId,
    input: {
      actor: {
        id: runtimeActorId("workflow", {
          runId: context.runId,
          workflowId: context.workflowId,
        }),
        kind: "workflow",
        systemId,
      },
      buildResult: (outcome, nodes, failure) =>
        workflowRuntimeResult(context, outcome, nodes, failure),
      emitWorkflowPlanned: () => emitWorkflowPlanned(context),
      emitWorkflowStarted: () =>
        emit(context, {
          nodeIds: context.plan.topologicalOrder.map((node) => node.id),
          type: "workflow.start",
          workflowId: context.workflowId,
        }),
      failFast: context.plan.execution.failFast,
      isCancelled: () => isCancelled(context),
      markNodeReady: (nodeId) =>
        recordNodeEvent(context, nodeId, { at: now(), type: "READY" }),
      maxParallelNodes: context.maxParallelNodes,
      nodes: context.plan.topologicalOrder.map((node) => ({
        dependents: node.dependents,
        id: node.id,
        index: node.index,
        needs: node.needs,
      })),
      runNode: (nodeId) => executePlannedNode(nodeId, context),
      runWorkflowHook: (event, failure) =>
        dispatchHooks(context, event, failure),
      shouldContinueAfterNodeResult: (result) =>
        shouldContinueAfterNodeResult(result, context),
      skipNode: (nodeId, reason) =>
        recordSkippedNodeState(context, nodeId, reason, now()),
    },
    ...(runtimeInspection(context)
      ? { inspect: runtimeInspection(context) }
      : {}),
  });
  context.workflowActor = actor;
  actor.start();
  actor.send({ type: "START" });
  return actor;
}

async function pinWorkflowBaseSha(context: RuntimeContext): Promise<void> {
  if (planContainsWorktreeBackedWorkflowNode(context.plan)) {
    await workflowBaseSha(context);
  }
}

function shouldContinueAfterNodeResult(
  result: RuntimeNodeResult,
  context: RuntimeContext
): boolean {
  if (result.status !== "failed") {
    return true;
  }
  const node = context.plan.graph.node(result.nodeId);
  if (node?.kind !== "parallel" || !parallelOutputHasChildren(result.output)) {
    return false;
  }
  return (
    node.dependents.length > 0 &&
    node.dependents.every((dependentId) =>
      isDrainMergeNode(context.plan.graph.node(dependentId))
    )
  );
}

function parallelOutputHasChildren(output: string): boolean {
  return (
    Object.keys(parseJsonObject(parseJsonObject(output).children)).length > 0
  );
}

function isDrainMergeNode(node: PlannedWorkflowNode | undefined): boolean {
  return node?.kind === "builtin" && node.builtin === "drain-merge";
}

async function executePlannedNode(
  nodeId: string,
  context: RuntimeContext
): Promise<RuntimeNodeResult> {
  const node = context.plan.graph.node(nodeId);
  if (!node) {
    throw new Error(`workflow scheduler referenced unknown node '${nodeId}'`);
  }
  const result = await executeNode(node, context);
  await dispatchHooks(
    context,
    "node.finish",
    result.status === "failed" ? nodeRuntimeFailure(result) : undefined,
    node
  );
  return result;
}

function workflowRuntimeResult(
  context: RuntimeContext,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure
): PipelineRuntimeResult {
  if (outcome === "CANCELLED") {
    return cancelledRuntimeResult(context, nodes);
  }
  if (outcome === "FAIL") {
    return failedRuntimeResult(
      context,
      nodes,
      failure ?? workflowRuntimeFailure()
    );
  }
  return passedRuntimeResult(context, nodes);
}

function passedRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): PipelineRuntimeResult {
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "PASS",
    plan: context.plan,
    structuredOutputs: runtimeStructuredOutputs(context),
  };
}

function workflowRuntimeFailure(): RuntimeFailure {
  return {
    evidence: ["workflow failed without a specific failure"],
    gate: "workflow",
    reason: "workflow failed",
  };
}

function nodeRuntimeFailure(node: RuntimeNodeResult): RuntimeFailure {
  return {
    evidence: node.evidence,
    gate: node.nodeId,
    nodeId: node.nodeId,
    reason: `node '${node.nodeId}' failed`,
  };
}

function finishRuntime(
  context: RuntimeContext,
  result: PipelineRuntimeResult
): PipelineRuntimeResult {
  emitWorkflowFinish(context, result.outcome);
  return result;
}

function failedRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[],
  failure: RuntimeFailure
): PipelineRuntimeResult {
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [failure],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "FAIL",
    plan: context.plan,
    structuredOutputs: runtimeStructuredOutputs(context),
  };
}

function cancelledRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): PipelineRuntimeResult {
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [cancelledFailure()],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "CANCELLED",
    plan: context.plan,
    structuredOutputs: runtimeStructuredOutputs(context),
  };
}

function runtimeNodeStates(
  context: RuntimeContext
): Record<string, NodeExecutionState> {
  return Object.fromEntries(context.nodeStates);
}

function runtimeStructuredOutputs(
  context: RuntimeContext
): RuntimeStructuredOutput[] {
  return [...context.structuredOutputs];
}

function cancelledFailure(): RuntimeFailure {
  return {
    evidence: ["pipeline cancelled by AbortSignal"],
    gate: "cancelled",
    reason: "pipeline cancelled",
  };
}

function recordSkippedNodeState(
  context: RuntimeContext,
  nodeId: string,
  reason: string,
  at: string
): void {
  const state =
    context.nodeStates.get(nodeId) ??
    ({
      attempts: 0,
      evidence: [],
      gates: [],
      id: nodeId,
      status: "pending",
    } satisfies NodeExecutionState);
  context.nodeStates.set(nodeId, {
    ...state,
    failure: {
      evidence: [reason],
      gate: nodeId,
      nodeId,
      reason,
    },
    finishedAt: at,
    status: "skipped",
  });
}

function nodeActor(
  context: RuntimeContext,
  nodeId: string
): NodeExecutionActor {
  const existing = context.nodeActors.get(nodeId);
  if (existing) {
    return existing;
  }
  const actor = createActor(nodeExecutionMachine, {
    id: runtimeActorId("node", {
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    input: {
      actor: {
        id: runtimeActorId("node", {
          nodeId,
          runId: context.runId,
          workflowId: context.workflowId,
        }),
        kind: "node",
        systemId: runtimeSystemId(context),
      },
      nodeId,
    },
    ...(runtimeInspection(context)
      ? { inspect: runtimeInspection(context) }
      : {}),
  });
  actor.start();
  context.nodeActors.set(nodeId, actor);
  context.nodeStates.set(nodeId, actor.getSnapshot().context.state);
  return actor;
}

function recordNodeEvent(
  context: RuntimeContext,
  nodeId: string,
  event: Parameters<NodeExecutionActor["send"]>[0]
): void {
  const actor = nodeActor(context, nodeId);
  actor.send(event);
  context.nodeStates.set(nodeId, actor.getSnapshot().context.state);
  if (event.type === "RETRYING") {
    const retry = actor.getSnapshot().context.state.retry;
    if (!retry || event.policy.maxAttempts <= 1) {
      return;
    }
    context.observability?.({
      actor: runtimeNodeActorDescriptor(context, nodeId),
      attempt: retry.scheduled ? event.attempt + 1 : event.attempt,
      nodeId,
      reason: event.retryReason,
      timestamp: event.at,
      type: retry.scheduled
        ? "runtime.retry.scheduled"
        : "runtime.retry.exhausted",
    });
  }
}

function now(): string {
  return new Date().toISOString();
}

function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
}

async function executeNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<RuntimeNodeResult> {
  const retryPolicy = nodeRetryPolicy(node);
  let last: NodeAttemptResult = {
    evidence: [],
    exitCode: 1,
    output: "",
  };
  let retry: NodeAttemptRetry | undefined;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const cycle = await executeNodeAttemptCycle(node, context, attempt, last);
      last = cycle.last;
      if (cycle.result) {
        emitNodeFinish(context, cycle.result);
        return cycle.result;
      }
      retry = retryCandidateForCycle(node, cycle, last, attempt);
      const selfRemediation = await remediateWritableNodeFailure({
        attempt,
        context,
        node,
        retry,
      });
      if (selfRemediation) {
        recordNodeEvent(context, node.id, {
          at: now(),
          result: selfRemediation,
          type: "PASSED",
        });
        emitNodeFinish(context, selfRemediation);
        return selfRemediation;
      }
      if (
        await remediateCoverageFailure({
          attempt,
          context,
          node,
          retry,
        })
      ) {
        continue;
      }
      recordNodeEvent(context, node.id, {
        at: now(),
        attempt,
        evidence: retry.evidence,
        gate: retry.gate,
        policy: retryPolicy,
        reason: retry.reason,
        retryReason: retry.retryReason,
        type: "RETRYING",
      });
      const retryDecision = context.nodeStates.get(node.id)?.retry;
      if (!retryDecision?.scheduled) {
        break;
      }
      await waitForRetryDelay(retryDecision.delayMs, context.signal);
    } catch (err) {
      if (isCancelled(context)) {
        retry = {
          attempt,
          evidence: [...last.evidence, ...cancelledFailure().evidence],
          gate: node.id,
          reason: "pipeline cancelled",
          retryReason: "timeout",
        };
        break;
      }
      retry = {
        attempt,
        evidence: [
          ...last.evidence,
          err instanceof Error ? err.message : String(err),
        ],
        gate: node.id,
        reason: err instanceof Error ? err.message : "node retry failed",
        retryReason: nodeRetryReason(last),
      };
      break;
    }
  }

  retry ??= {
    attempt: Math.max(1, retryPolicy.maxAttempts),
    evidence: last.evidence,
    gate: node.id,
    reason: `node exited with code ${last.exitCode}`,
    retryReason: nodeRetryReason(last),
  };
  await dispatchHooks(
    context,
    "node.error",
    {
      evidence: retry.evidence,
      gate: retry.gate,
      nodeId: node.id,
      reason: retry.reason,
    },
    node
  );
  const result = nodeFailure(
    node.id,
    retry.attempt,
    retry.evidence,
    last.output
  );
  recordNodeEvent(context, node.id, {
    at: now(),
    failure: nodeRuntimeFailure(result),
    result,
    type: "FAILED",
  });
  emitNodeFinish(context, result);
  return result;
}

async function remediateWritableNodeFailure(input: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<RuntimeNodeResult | null> {
  if (
    input.retry.retryReason !== "gate_failure" ||
    isRemediationNode(input.node) ||
    !nodeCanWrite(input.context, input.node)
  ) {
    return null;
  }

  const beforeSnapshot = await snapshotChangedFiles(input.context.worktreePath);
  const beforeOutput = input.context.lastOutputByNode.get(input.node.id);
  const result = await executeSelfRemediation(input);
  if (result.status !== "passed") {
    return null;
  }

  const changed = diffChangedFiles(
    beforeSnapshot,
    await snapshotChangedFiles(input.context.worktreePath),
    input.context.worktreePath
  );
  if (changed.files.size === 0 && result.output === beforeOutput) {
    return null;
  }

  input.context.nodeSnapshots.set(input.node.id, changed);
  input.context.lastOutputByNode.set(input.node.id, result.output);
  return {
    attempts: input.attempt + 1,
    evidence: result.evidence,
    exitCode: result.exitCode,
    nodeId: input.node.id,
    output: result.output,
    status: "passed",
  };
}

async function executeSelfRemediation(input: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<RuntimeNodeResult> {
  const node: PlannedWorkflowNode = {
    ...input.node,
    artifacts: undefined,
    dependents: [],
    id: `${input.node.id}:remediate:${input.retry.gate}:${input.attempt}`,
    needs: [],
    retries: undefined,
  };
  const originalTask = input.context.task;
  input.context.task = nodeRemediationTask({
    node: input.node,
    originalTask,
    retry: input.retry,
  });
  try {
    return await executeNode(node, input.context);
  } finally {
    input.context.task = originalTask;
  }
}

async function remediateCoverageFailure(input: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<boolean> {
  if (
    input.retry.retryReason !== "gate_failure" ||
    !hasSchedulingRole(input.context, input.node, "coverage")
  ) {
    return false;
  }
  const implementationNodes = upstreamImplementationNodes(
    input.context,
    input.node
  ).filter(
    (candidate) =>
      input.context.nodeStates.get(candidate.id)?.status === "passed"
  );
  if (implementationNodes.length === 0) {
    return false;
  }

  for (const implementationNode of implementationNodes) {
    if (isCancelled(input.context)) {
      return false;
    }
    const beforeSnapshot = await snapshotChangedFiles(
      input.context.worktreePath
    );
    const beforeOutput = input.context.lastOutputByNode.get(
      implementationNode.id
    );
    const result = await executeImplementationRemediation({
      attempt: input.attempt,
      context: input.context,
      coverageNode: input.node,
      implementationNode,
      retry: input.retry,
    });
    if (result.status !== "passed") {
      return false;
    }
    const changed = diffChangedFiles(
      beforeSnapshot,
      await snapshotChangedFiles(input.context.worktreePath),
      input.context.worktreePath
    );
    if (changed.files.size === 0 && result.output === beforeOutput) {
      return false;
    }
    input.context.lastOutputByNode.set(implementationNode.id, result.output);
  }
  return true;
}

async function executeImplementationRemediation(input: {
  attempt: number;
  context: RuntimeContext;
  coverageNode: PlannedWorkflowNode;
  implementationNode: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<RuntimeNodeResult> {
  const node: PlannedWorkflowNode = {
    ...input.implementationNode,
    artifacts: undefined,
    dependents: [],
    gates: undefined,
    id: `${input.implementationNode.id}:remediate:${input.coverageNode.id}:${input.attempt}`,
    needs: [],
    retries: undefined,
  };
  const originalTask = input.context.task;
  input.context.task = remediationTask({
    coverageNode: input.coverageNode,
    originalTask,
    retry: input.retry,
  });
  try {
    return await executeNode(node, input.context);
  } finally {
    input.context.task = originalTask;
  }
}

function remediationTask(input: {
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

function nodeCanWrite(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): boolean {
  if (!node.profile) {
    return false;
  }
  const profile = context.config.profiles[node.profile];
  return (
    profile?.filesystem?.mode === "workspace-write" ||
    (profile?.tools ?? []).some((tool) => tool === "edit" || tool === "write")
  );
}

function isRemediationNode(node: PlannedWorkflowNode): boolean {
  return node.id.includes(":remediate:");
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
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const candidate = context.plan.graph.node(nodeId);
    if (!candidate) {
      return;
    }
    for (const need of candidate.needs) {
      visit(need);
    }
    if (hasSchedulingRole(context, candidate, "implementation")) {
      ordered.push(candidate);
    }
  };
  for (const need of node.needs) {
    visit(need);
  }
  return ordered;
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

type NodeRetryPolicy = NodeRetryPolicyContract;

function nodeRetryPolicy(node: PlannedWorkflowNode): NodeRetryPolicy {
  let retryOn: RetryReason[] = ["exit_nonzero", "gate_failure", "timeout"];
  if (node.retries?.retry_on) {
    retryOn = [...node.retries.retry_on];
  }
  return {
    backoffMs: node.retries?.backoff_ms ? node.retries.backoff_ms : 0,
    maxAttempts: node.retries?.max_attempts ? node.retries.max_attempts : 1,
    multiplier: node.retries?.multiplier ? node.retries.multiplier : 1,
    retryOn,
  };
}

async function waitForRetryDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

async function executeNodeAttemptCycle(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  previous: NodeAttemptResult
): Promise<NodeAttemptCycleResult> {
  if (isCancelled(context)) {
    return {
      last: previous,
      result: nodeFailure(
        node.id,
        attempt,
        cancelledFailure().evidence,
        previous.output
      ),
    };
  }

  emitNodeStart(context, node, attempt);
  recordNodeEvent(context, node.id, {
    at: now(),
    attempt,
    type: "STARTED",
  });
  const startHook = await dispatchHooks(context, "node.start", undefined, node);
  if (startHook) {
    const result = nodeFailure(
      node.id,
      attempt,
      startHook.evidence,
      previous.output
    );
    recordNodeEvent(context, node.id, {
      at: now(),
      failure: nodeRuntimeFailure(result),
      result,
      type: "FAILED",
    });
    return {
      last: previous,
      result,
    };
  }
  if (isCancelled(context)) {
    return {
      last: previous,
      result: nodeFailure(
        node.id,
        attempt,
        cancelledFailure().evidence,
        previous.output
      ),
    };
  }

  recordNodeEvent(context, node.id, {
    at: now(),
    type: "START_HOOKS_FINISHED",
  });
  context.nodeSnapshots.set(
    node.id,
    await snapshotChangedFiles(context.worktreePath)
  );
  recordNodeEvent(context, node.id, {
    at: now(),
    type: "SNAPSHOT_BEFORE_FINISHED",
  });
  recordNodeEvent(context, node.id, {
    at: now(),
    type: "RUNNER_STARTED",
  });
  const last = await executeNodeAttempt(node, context, attempt);
  recordNodeEvent(context, node.id, {
    at: now(),
    evidence: last.evidence,
    exitCode: last.exitCode,
    output: last.output,
    timedOut: last.timedOut,
    type: "RUNNER_FINISHED",
  });
  const afterSnapshot = await snapshotChangedFiles(context.worktreePath);
  const beforeSnapshot = context.nodeSnapshots.get(node.id);
  if (beforeSnapshot) {
    context.nodeSnapshots.set(
      node.id,
      diffChangedFiles(beforeSnapshot, afterSnapshot, context.worktreePath)
    );
  }
  context.lastOutputByNode.set(node.id, last.output);
  emitNodeOutputRecorded(context, node, attempt, last.output);
  recordNodeEvent(context, node.id, {
    at: now(),
    type: "OUTPUT_RECORDED",
  });
  recordNodeEvent(context, node.id, {
    at: now(),
    type: "SNAPSHOT_AFTER_FINISHED",
  });
  const cancelledAfterAttempt = cancelledNodeResult(
    context,
    node.id,
    attempt,
    last
  );
  if (cancelledAfterAttempt) {
    return { last, result: cancelledAfterAttempt };
  }

  recordNodeEvent(context, node.id, { at: now(), type: "GATES_STARTED" });
  const gateResults = await evaluateNodeGates(
    node,
    context,
    last,
    (failedNode, result) => dispatchGateFailureHook(context, failedNode, result)
  );
  recordNodeEvent(context, node.id, {
    at: now(),
    gates: gateResults,
    type: "GATES_FINISHED",
  });
  const cancelledAfterGates = cancelledNodeResult(
    context,
    node.id,
    attempt,
    last
  );
  if (cancelledAfterGates) {
    return { last, result: cancelledAfterGates };
  }

  const failedGate = gateResults.find((gate) => !gate.passed);
  if (!failedGate && last.exitCode === 0) {
    const successHook = await dispatchHooks(
      context,
      "node.success",
      undefined,
      node
    );
    if (successHook) {
      const result = nodeFailure(
        node.id,
        attempt,
        successHook.evidence,
        last.output
      );
      recordNodeEvent(context, node.id, {
        at: now(),
        failure: nodeRuntimeFailure(result),
        result,
        type: "FAILED",
      });
      return { last, result };
    }
    const cancelledAfterHook = cancelledNodeResult(
      context,
      node.id,
      attempt,
      last
    );
    if (cancelledAfterHook) {
      return { last, result: cancelledAfterHook };
    }
    const result: RuntimeNodeResult = {
      attempts: attempt,
      evidence: last.evidence,
      exitCode: 0,
      nodeId: node.id,
      output: last.output,
      status: "passed",
    };
    recordNodeEvent(context, node.id, {
      at: now(),
      result,
      type: "PASSED",
    });
    return { last, result };
  }

  const evidence = failedGate
    ? [...last.evidence, ...failedGate.evidence]
    : last.evidence.concat(`node exited with code ${last.exitCode}`);
  const retryReason = nodeRetryReason(last, failedGate);
  return {
    last,
    retry: {
      attempt,
      evidence,
      gate: failedGate?.gateId ?? node.id,
      reason: failedGate?.reason ?? `node exited with code ${last.exitCode}`,
      retryReason,
    },
  };
}

function nodeRetryReason(
  attempt: NodeAttemptResult,
  failedGate?: RuntimeGateResult
): RetryReason {
  if (attempt.timedOut) {
    return "timeout";
  }
  if (failedGate) {
    return "gate_failure";
  }
  return "exit_nonzero";
}

function retryCandidateForCycle(
  node: PlannedWorkflowNode,
  cycle: NodeAttemptCycleResult,
  last: NodeAttemptResult,
  attempt: number
): NodeAttemptRetry {
  return (
    cycle.retry ?? {
      attempt,
      evidence: last.evidence,
      gate: node.id,
      reason: `node exited with code ${last.exitCode}`,
      retryReason: nodeRetryReason(last),
    }
  );
}

function cancelledNodeResult(
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult
): RuntimeNodeResult | null {
  if (!isCancelled(context)) {
    return null;
  }
  const result: RuntimeNodeResult = {
    attempts: attempt,
    evidence: [...last.evidence, ...cancelledFailure().evidence],
    exitCode: last.exitCode,
    nodeId,
    output: last.output,
    status: last.exitCode === 0 ? "passed" : "failed",
  };
  recordNodeEvent(context, nodeId, {
    at: now(),
    failure: cancelledFailure(),
    type: "CANCELLED",
  });
  return result;
}

function nodeFailure(
  nodeId: string,
  attempts: number,
  evidence: string[],
  output: string
): RuntimeNodeResult {
  return {
    attempts,
    evidence,
    exitCode: 1,
    nodeId,
    output,
    status: "failed",
  };
}

function executeNodeAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): NodeAttemptResult | Promise<NodeAttemptResult> {
  switch (node.kind) {
    case "agent":
      return executeAgentNode(node, context, attempt);
    case "command":
      return executeCommand(node.command ?? [], context, {
        timeout: node.timeoutMs,
      });
    case "builtin":
      return executeBuiltin(node.builtin ?? "", context, node);
    case "group":
      return {
        evidence: [`group '${node.id}' completed`],
        exitCode: 0,
        output: "",
      };
    case "parallel":
      return executeParallelNode(node, context, {
        executeNode,
        isDrainMergeNode,
        markNodeReady: (childContext, childId) =>
          recordNodeEvent(childContext, childId, {
            at: now(),
            type: "READY",
          }),
      });
    case "workflow":
      return executeWorkflowNode(node, context);
    default: {
      const _exhaustive: never = node.kind;
      throw new Error(`Unsupported node kind: ${String(_exhaustive)}`);
    }
  }
}

async function executeWorkflowNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<NodeAttemptResult> {
  if (!node.workflow) {
    return {
      evidence: [`workflow node '${node.id}' has no workflow`],
      exitCode: 1,
      output: "",
    };
  }

  const worktree = await prepareWorkflowNodeWorktree(node, context);
  const childContext = createRuntimeContext({
    config: context.config,
    executor: context.executor,
    hookPolicy: context.hookPolicy,
    reporter: childReporter(context, node.id),
    runId: context.runId,
    signal: context.signal,
    task: context.task,
    taskContext: effectiveTaskContext(node, context),
    workflowId: node.workflow,
    worktreePath: worktree.worktreePath ?? context.worktreePath,
  });
  childContext.baseSha = context.baseSha;
  childContext.hookResults = new Map(context.hookResults);
  childContext.lastOutputByNode = workflowChildInheritedOutputs(node, context);
  childContext.inheritedOutputNodeIds = new Set(
    childContext.lastOutputByNode.keys()
  );

  const result = await runPipelineWithContext(childContext);
  context.agentInvocations.push(...result.agentInvocations);
  if (result.outcome === "PASS" && worktree.worktreePath) {
    try {
      worktree.commitSha = await commitWorkflowNodeWorktree(
        worktree.worktreePath,
        node.id,
        context.config.runner_job.git.committer
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        evidence: [
          `workflow '${result.plan.workflowId}' passed`,
          `workflow worktree commit failed: ${message}`,
          `inspect workflow worktree: cd ${worktree.worktreePath}`,
        ],
        exitCode: 1,
        output: JSON.stringify({
          baseSha: worktree.baseSha,
          branch: worktree.branch,
          commitSha: worktree.commitSha ?? null,
          nodeResults: result.nodes.map((child) => ({
            nodeId: child.nodeId,
            status: child.status,
          })),
          status: "FAIL",
          worktreePath: worktree.worktreePath,
          workflowId: result.plan.workflowId,
        }),
      };
    }
  }
  if (
    result.outcome === "PASS" &&
    worktree.worktreePath &&
    !shouldPreserveWorkflowNodeWorktree(node, context)
  ) {
    await removeWorkflowNodeWorktree(worktree.worktreePath);
  }
  const output = JSON.stringify({
    baseSha: worktree.baseSha,
    branch: worktree.branch,
    ...(worktree.worktreePath ? { commitSha: worktree.commitSha ?? null } : {}),
    nodeResults: result.nodes.map((child) => ({
      nodeId: child.nodeId,
      status: child.status,
    })),
    status: result.outcome,
    worktreePath: worktree.worktreePath,
    workflowId: result.plan.workflowId,
  });
  return {
    evidence: [
      result.outcome === "PASS"
        ? `workflow '${result.plan.workflowId}' passed`
        : `workflow '${result.plan.workflowId}' failed`,
      ...(result.outcome === "PASS" || !worktree.worktreePath
        ? []
        : [`inspect workflow worktree: cd ${worktree.worktreePath}`]),
      ...result.failureDetails.flatMap((failure) => failure.evidence),
    ],
    exitCode: result.outcome === "PASS" ? 0 : 1,
    output,
  };
}

function shouldPreserveWorkflowNodeWorktree(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): boolean {
  if (context.preserveSuccessfulWorkflowWorktrees) {
    return true;
  }
  const plannedNode = context.plan.graph.node(node.id);
  return (
    plannedNode?.dependents.length > 0 &&
    plannedNode.dependents.every((dependentId) =>
      isDrainMergeNode(context.plan.graph.node(dependentId))
    )
  );
}

function workflowChildInheritedOutputs(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Map<string, string> {
  const siblingNodeIds = new Set(
    context.plan.topologicalOrder.map((candidate) => candidate.id)
  );
  return new Map(
    [...context.lastOutputByNode].map(([nodeId, output]) => [
      nodeId,
      filterWorkflowChildRoutedOutput(output, node.id, siblingNodeIds),
    ])
  );
}

function filterWorkflowChildRoutedOutput(
  output: string,
  childNodeId: string,
  siblingNodeIds: Set<string>
): string {
  const parsed = parseJsonObject(output);
  if (!Object.hasOwn(parsed, childNodeId)) {
    return output;
  }
  const routedSiblingKeys = Object.keys(parsed).filter((key) =>
    siblingNodeIds.has(key)
  );
  if (routedSiblingKeys.length <= 1) {
    return output;
  }
  return JSON.stringify({ [childNodeId]: parsed[childNodeId] });
}

async function dispatchGateFailureHook(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  result: RuntimeGateResult
): Promise<void> {
  await dispatchHooks(
    context,
    "gate.failure",
    {
      evidence: result.evidence,
      gate: result.gateId,
      nodeId: node.id,
      reason: result.reason ?? "gate failed",
    },
    node,
    result.gateId
  );
}

export function formatConfigError(err: PipelineConfigError): string {
  return [
    err.message,
    ...err.issues.map((issue) =>
      issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
    ),
  ].join("\n");
}
