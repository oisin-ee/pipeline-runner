import {
  loadPipelineConfig,
  type PipelineConfig,
  type PipelineConfigError,
} from "./config";
import { findPlannedNode } from "./planned-node";
import type { PlannedWorkflowNode } from "./planning/compile";
import type { RetryReason } from "./runtime/actor-ids";
import { executeAgentNode } from "./runtime/agent-node";
import { executeBuiltin } from "./runtime/builtins";
import {
  diffChangedFiles,
  snapshotChangedFiles,
} from "./runtime/changed-files";
import { executeCommand } from "./runtime/command-executor";
import { createRuntimeContext } from "./runtime/context";
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
  emitNodeFinish,
  emitNodeOutputRecorded,
  emitNodeStart,
  emitWorkflowFinish,
  emitWorkflowPlanned,
  emitWorkflowStarted,
  runtimeNodeActorDescriptor,
} from "./runtime/events";
import { evaluateNodeGates } from "./runtime/gates";
import { dispatchHooks } from "./runtime/hooks";
import { parseJsonObject } from "./runtime/json-validation";
import {
  type NodeExecutionEvent,
  NodeStateTracker,
} from "./runtime/node-state-tracker";
import {
  configUsesOpencode,
  leaseOpencodeRuntime,
  type RuntimeExecutor,
} from "./runtime/opencode-runtime";
import { executeParallelNode } from "./runtime/parallel-node";
import { decideNodeRetry, nodeRetryPolicy } from "./runtime/retry";
import { LocalScheduler, type PipelineScheduler } from "./runtime/scheduler";

/**
 * Top layer of the runtime-options stack (PIPE-74 B3). Extends
 * {@link PipelineRuntimeOptions} for the schedule-driven path that runs a
 * SINGLE workflow node (`nodeId`) in isolation, supplying that node's upstream
 * `dependencyOutputs`. Full stack:
 *   RunnerExecutionOptions (src/runner.ts)
 *     < PipelineRuntimeOptions (src/runtime/contracts/contracts.ts)
 *     < ScheduledWorkflowTaskRuntimeOptions (this type)
 */
export interface ScheduledWorkflowTaskRuntimeOptions
  extends PipelineRuntimeOptions {
  dependencyOutputs?: Map<string, string> | Record<string, string>;
  nodeId: string;
}

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
  return withOpencodeRuntime(options, (resolved) =>
    runPipelineWithContext(createRuntimeContext(resolved))
  );
}

export function runScheduledWorkflowTask(
  options: ScheduledWorkflowTaskRuntimeOptions
): Promise<RuntimeNodeResult> {
  const { dependencyOutputs, nodeId, ...runtimeOptions } = options;
  return withOpencodeRuntime(runtimeOptions, (resolved) => {
    const context = createRuntimeContext(resolved);
    hydrateScheduledDependencyStates(context, nodeId);
    hydrateDependencyOutputs(context, dependencyOutputs);
    recordNodeEvent(context, nodeId, { at: now(), type: "READY" });
    return executePlannedNode(nodeId, context);
  });
}

/**
 * When the config uses opencode and the caller did not inject an executor,
 * open one opencode server for the run, drive nodes through the SDK executor,
 * and tear the server down afterward. Command-only configs and callers that
 * supply their own executor (tests, embedders) are passed through untouched.
 */
async function withOpencodeRuntime<T>(
  options: PipelineRuntimeOptions,
  run: (resolved: PipelineRuntimeOptions) => Promise<T>
): Promise<T> {
  if (options.executor) {
    return await run(options);
  }
  const { config, worktreePath } = resolveConfigForRun(options);
  return configUsesOpencode(config)
    ? await runWithLeasedOpencode(options, config, worktreePath, run)
    : await run({ ...options, config });
}

function resolveConfigForRun(options: PipelineRuntimeOptions): {
  config: PipelineConfig;
  worktreePath: string;
} {
  const worktreePath = options.worktreePath ?? process.cwd();
  return {
    config: options.config ?? loadPipelineConfig(worktreePath),
    worktreePath,
  };
}

async function runWithLeasedOpencode<T>(
  options: PipelineRuntimeOptions,
  config: PipelineConfig,
  worktreePath: string,
  run: (resolved: PipelineRuntimeOptions) => Promise<T>
): Promise<T> {
  const lease = await leaseOpencodeRuntime({
    config,
    ...(options.signal ? { signal: options.signal } : {}),
    worktreePath,
  });
  try {
    return await run({
      ...options,
      config,
      executor: lease.executor as RuntimeExecutor,
    });
  } finally {
    await lease.release();
  }
}

async function runPipelineWithContext(
  context: RuntimeContext
): Promise<PipelineRuntimeResult> {
  const scheduler: PipelineScheduler = new LocalScheduler({
    buildResult: (outcome, nodes, failure) =>
      workflowRuntimeResult(context, outcome, nodes, failure),
    emitWorkflowPlanned: (nextContext) => emitWorkflowPlanned(nextContext),
    emitWorkflowStarted: (nextContext) => emitWorkflowStarted(nextContext),
    executeNode: (nodeId, nextContext) =>
      executePlannedNode(nodeId, nextContext),
    isCancelled: (nextContext) => isCancelled(nextContext),
    markNodeReady: (nodeId, nextContext) =>
      recordNodeEvent(nextContext, nodeId, { at: now(), type: "READY" }),
    runWorkflowHook: (event, failure, nextContext) =>
      dispatchHooks(nextContext, event, failure),
    shouldContinueAfterNodeResult: (result, nextContext) =>
      shouldContinueAfterNodeResult(result, nextContext),
    skipNode: (nodeId, reason, nextContext) =>
      recordSkippedNodeState(nextContext, nodeId, reason, now()),
  });
  return finishRuntime(
    context,
    await scheduler.runWorkflow(context.plan, context)
  );
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
  const node = plannedNodeById(context, nodeId);
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

function plannedNodeById(
  context: RuntimeContext,
  nodeId: string
): PlannedWorkflowNode | undefined {
  return (
    context.plan.graph.node(nodeId) ??
    findPlannedNode(context.plan.topologicalOrder, nodeId)
  );
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
  return context.nodeStateStore.toNodeStateRecord();
}

function runtimeStructuredOutputs(
  context: RuntimeContext
): RuntimeStructuredOutput[] {
  return context.nodeStateStore.structuredOutputList();
}

function hydrateDependencyOutputs(
  context: RuntimeContext,
  dependencyOutputs: ScheduledWorkflowTaskRuntimeOptions["dependencyOutputs"]
): void {
  const outputs =
    dependencyOutputs instanceof Map
      ? dependencyOutputs
      : new Map(Object.entries(dependencyOutputs ?? {}));
  const finishedAt = now();
  for (const [nodeId, output] of outputs) {
    const existing = context.nodeStateStore.getNodeState(nodeId);
    context.nodeStateStore.recordOutput(nodeId, output);
    context.nodeStateStore.markInheritedOutput(nodeId);
    context.nodeStateStore.setNodeState(nodeId, {
      attempts: existing?.attempts ?? 1,
      evidence: [
        ...(existing?.evidence ?? []),
        "dependency output inherited from Argo artifact",
      ],
      exitCode: existing?.exitCode ?? 0,
      finishedAt: existing?.finishedAt ?? finishedAt,
      gates: existing?.gates ?? [],
      id: nodeId,
      output,
      status: "passed",
    });
  }
}

function hydrateScheduledDependencyStates(
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
  recordNodeEvent(context, nodeId, { at, reason, type: "SKIPPED" });
}

function recordNodeEvent(
  context: RuntimeContext,
  nodeId: string,
  event: NodeExecutionEvent
): void {
  const tracker = new NodeStateTracker(
    nodeId,
    context.nodeStateStore.getNodeState(nodeId)
  );
  const state = tracker.record(event);
  context.nodeStateStore.setNodeState(nodeId, state);
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
      const remediation = await remediateFailedNode({
        attempt,
        context,
        node,
        retry,
      });
      if (remediation?.result) {
        recordNodeEvent(context, node.id, {
          at: now(),
          result: remediation.result,
          type: "PASSED",
        });
        emitNodeFinish(context, remediation.result);
        return remediation.result;
      }
      if (remediation?.retryNode) {
        continue;
      }
      const retryDecision = decideNodeRetry({
        attempt,
        evidence: retry.evidence,
        gate: retry.gate,
        policy: retryPolicy,
        reason: retry.reason,
        retryReason: retry.retryReason,
      });
      recordNodeEvent(context, node.id, {
        at: now(),
        attempt,
        evidence: retry.evidence,
        gate: retry.gate,
        reason: retry.reason,
        retry: retryDecision,
        retryReason: retry.retryReason,
        type: "RETRYING",
      });
      emitRuntimeRetry(context, node.id, retryDecision, retry.retryReason);
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

function emitRuntimeRetry(
  context: RuntimeContext,
  nodeId: string,
  retry: ReturnType<typeof decideNodeRetry>,
  reason: RetryReason
): void {
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, nodeId),
    attempt: retry.scheduled ? retry.attempt + 1 : retry.attempt,
    nodeId,
    reason,
    timestamp: now(),
    type: retry.scheduled
      ? "runtime.retry.scheduled"
      : "runtime.retry.exhausted",
  });
}

interface NodeRemediationResult {
  result?: RuntimeNodeResult;
  retryNode?: boolean;
}

async function remediateFailedNode(input: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<NodeRemediationResult | null> {
  const selfRemediation = await remediateWritableNodeFailure(input);
  if (selfRemediation) {
    return { result: selfRemediation };
  }
  if (await remediateCoverageFailure(input)) {
    return { retryNode: true };
  }
  if (await remediateUpstreamImplementationFailure(input)) {
    return { retryNode: true };
  }
  return null;
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
  const beforeOutput = input.context.nodeStateStore.getOutput(input.node.id);
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

  input.context.nodeStateStore.setSnapshot(input.node.id, changed);
  input.context.nodeStateStore.recordOutput(input.node.id, result.output);
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
  return await remediatePassedImplementationAncestors(input);
}

async function remediateUpstreamImplementationFailure(input: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<boolean> {
  if (
    isRemediationNode(input.node) ||
    nodeCanWrite(input.context, input.node) ||
    hasSchedulingRole(input.context, input.node, "coverage")
  ) {
    return false;
  }
  return await remediatePassedImplementationAncestors(input);
}

async function remediatePassedImplementationAncestors(input: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  retry: NodeAttemptRetry;
}): Promise<boolean> {
  const implementationNodes = upstreamImplementationNodes(
    input.context,
    input.node
  ).filter(
    (candidate) =>
      input.context.nodeStateStore.getNodeState(candidate.id)?.status ===
      "passed"
  );
  if (implementationNodes.length === 0) {
    return false;
  }

  for (const implementationNode of implementationNodes) {
    if (!(await remediateImplementationAncestor(input, implementationNode))) {
      return false;
    }
  }
  return true;
}

async function remediateImplementationAncestor(
  input: {
    attempt: number;
    context: RuntimeContext;
    node: PlannedWorkflowNode;
    retry: NodeAttemptRetry;
  },
  implementationNode: PlannedWorkflowNode
): Promise<boolean> {
  if (isCancelled(input.context)) {
    return false;
  }
  const beforeSnapshot = await snapshotChangedFiles(input.context.worktreePath);
  const beforeOutput = input.context.nodeStateStore.getOutput(
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
  return await recordImplementationRemediationEffect({
    beforeOutput,
    beforeSnapshot,
    context: input.context,
    implementationNode,
    result,
  });
}

async function recordImplementationRemediationEffect(input: {
  beforeOutput: string | undefined;
  beforeSnapshot: Awaited<ReturnType<typeof snapshotChangedFiles>>;
  context: RuntimeContext;
  implementationNode: PlannedWorkflowNode;
  result: RuntimeNodeResult;
}): Promise<boolean> {
  const changed = diffChangedFiles(
    input.beforeSnapshot,
    await snapshotChangedFiles(input.context.worktreePath),
    input.context.worktreePath
  );
  if (changed.files.size === 0 && input.result.output === input.beforeOutput) {
    return false;
  }
  input.context.nodeStateStore.recordOutput(
    input.implementationNode.id,
    input.result.output
  );
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
  context.nodeStateStore.setSnapshot(
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
  const beforeSnapshot = context.nodeStateStore.getSnapshot(node.id);
  if (beforeSnapshot) {
    context.nodeStateStore.setSnapshot(
      node.id,
      diffChangedFiles(beforeSnapshot, afterSnapshot, context.worktreePath)
    );
  }
  context.nodeStateStore.recordOutput(node.id, last.output);
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
        markNodeReady: (childContext, childId) =>
          recordNodeEvent(childContext, childId, {
            at: now(),
            type: "READY",
          }),
      });
    default: {
      const _exhaustive: never = node.kind;
      throw new Error(`Unsupported node kind: ${String(_exhaustive)}`);
    }
  }
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
