import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ErrorObject } from "ajv";
import { execa } from "execa";
import micromatch from "micromatch";
import pLimit from "p-limit";
import simpleGit from "simple-git";
import { match } from "ts-pattern";
import {
  loadPipelineConfig,
  type PipelineConfig,
  type PipelineConfigError,
} from "./config.js";
import { artifactExists, runJscpd, runTests, runTypecheck } from "./gates.js";
import {
  type AgentResult,
  createRunnerLaunchPlan,
  type RunnerExecutionOptions,
  type RunnerLaunchPlan,
  runLaunchPlan,
} from "./runner.js";
import {
  compileWorkflowPlan,
  type PlannedWorkflowNode,
  type WorkflowExecutionPlan,
} from "./workflow-planner.js";

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];
type GateSpec = NonNullable<WorkflowNode["gates"]>[number];
type AcceptanceGateSpec = Extract<GateSpec, { kind: "acceptance" }>;
type ArtifactGateSpec = Extract<GateSpec, { kind: "artifact" }>;
type BuiltinGateSpec = Extract<GateSpec, { kind: "builtin" }>;
type ChangedFilesGateSpec = Extract<GateSpec, { kind: "changed_files" }>;
type CommandGateSpec = Extract<GateSpec, { kind: "command" }>;
type JsonSchemaGateSpec = Extract<GateSpec, { kind: "json_schema" }>;
type JsonSourceGateSpec = Extract<
  GateSpec,
  { kind: "acceptance" | "json_schema" | "verdict" }
>;
type VerdictGateSpec = Extract<GateSpec, { kind: "verdict" }>;
type HookSpec = PipelineConfig["hooks"][string];
const LINE_RE = /\r?\n/;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_OUTPUT_LIMIT_BYTES = 64 * 1024;
const jsonSchemaValidator = new Ajv({ allErrors: true, strict: false });

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface PipelineTaskContext {
  acceptanceCriteria?: AcceptanceCriterion[];
  description?: string;
  id?: string;
  title?: string;
}

export interface HookRuntimePolicy {
  allowCommandHooks?: boolean;
  allowUntrustedCommandHooks?: boolean;
  env?: Record<string, string>;
  envPassthrough?: string[];
  outputLimitBytes?: number;
  timeoutMs?: number;
}

export interface RuntimeFailure {
  evidence: string[];
  gate: string;
  nodeId?: string;
  reason: string;
}

export interface RuntimeGateResult {
  evidence: string[];
  gateId: string;
  kind: string;
  nodeId: string;
  passed: boolean;
  reason?: string;
}

export interface RuntimeNodeResult {
  attempts: number;
  evidence: string[];
  exitCode: number;
  nodeId: string;
  output: string;
  status: "failed" | "passed";
}

export type NodeStatus =
  | "cancelled"
  | "failed"
  | "gating"
  | "passed"
  | "pending"
  | "ready"
  | "running"
  | "skipped";

export interface NodeExecutionState {
  attempts: number;
  evidence: string[];
  exitCode?: number;
  failure?: RuntimeFailure;
  finishedAt?: string;
  gates: RuntimeGateResult[];
  id: string;
  output?: string;
  startedAt?: string;
  status: NodeStatus;
}

export interface PipelineRuntimeResult {
  agentInvocations: RunnerLaunchPlan[];
  failureDetails: RuntimeFailure[];
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  nodeStates: Record<string, NodeExecutionState>;
  nodes: RuntimeNodeResult[];
  outcome: "CANCELLED" | "FAIL" | "PASS";
  plan: WorkflowExecutionPlan;
}

export type PipelineRuntimeEvent =
  | {
      edges: { source: string; target: string }[];
      nodes: {
        id: string;
        kind: PlannedWorkflowNode["kind"];
        needs: string[];
        profile?: string;
        runnerId?: string;
      }[];
      type: "workflow.planned";
      workflowId: string;
    }
  | {
      nodeIds: string[];
      type: "workflow.start";
      workflowId: string;
    }
  | {
      attempt: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      type: "node.start";
    }
  | {
      attempt: number;
      exitCode: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      status: RuntimeNodeResult["status"];
      type: "node.finish";
    }
  | {
      attempt: number;
      format: string;
      nodeId: string;
      output: unknown;
      parseError?: string;
      profile?: string;
      schemaPath?: string;
      type: "node.output.recorded";
    }
  | {
      attempt: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      type: "agent.start";
    }
  | {
      attempt: number;
      exitCode: number;
      nodeId: string;
      profile?: string;
      runnerId?: string;
      type: "agent.finish";
    }
  | {
      gateId: string;
      kind: string;
      nodeId: string;
      type: "gate.start";
    }
  | {
      evidence?: string[];
      gateId: string;
      kind: string;
      nodeId: string;
      passed: boolean;
      reason?: string;
      type: "gate.finish";
    }
  | {
      nodeId: string;
      path: string;
      required: boolean;
      type: "artifact.check.start";
    }
  | {
      nodeId: string;
      passed: boolean;
      path: string;
      reason?: string;
      required: boolean;
      type: "artifact.check.finish";
    }
  | {
      event: HookSpec["event"];
      gateId?: string;
      hookId: string;
      nodeId?: string;
      required: boolean;
      type: "hook.start";
      workflowId: string;
    }
  | {
      event: HookSpec["event"];
      gateId?: string;
      hookId: string;
      nodeId?: string;
      passed: boolean;
      reason?: string;
      required: boolean;
      type: "hook.finish";
      workflowId: string;
    }
  | {
      attempt: number;
      nodeId: string;
      passed: boolean;
      reason?: string;
      type: "output.repair";
    }
  | {
      outcome: PipelineRuntimeResult["outcome"];
      type: "workflow.finish";
      workflowId: string;
    };

export interface PipelineRuntimeOptions {
  config?: PipelineConfig;
  entrypoint?: string;
  executor?: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  hookPolicy?: HookRuntimePolicy;
  maxParallelNodes?: number;
  reporter?: (event: PipelineRuntimeEvent) => void;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowId?: string;
  worktreePath?: string;
}

interface RuntimeContext {
  agentInvocations: RunnerLaunchPlan[];
  config: PipelineConfig;
  executor: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  hookPolicy: Required<HookRuntimePolicy>;
  lastOutputByNode: Map<string, string>;
  maxParallelNodes?: number;
  nodeSnapshots: Map<string, ChangedFilesSnapshot>;
  nodeStates: Map<string, NodeExecutionState>;
  plan: WorkflowExecutionPlan;
  reporter?: (event: PipelineRuntimeEvent) => void;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowId: string;
  worktreePath: string;
}

interface NodeAttemptResult {
  evidence: string[];
  exitCode: number;
  output: string;
  timedOut?: boolean;
}

interface ChangedFilesSnapshot {
  files: Set<string>;
}

interface CommandExecutionOptions {
  env?: Record<string, string>;
  extendEnv?: boolean;
  input?: string;
  outputLimitBytes?: number;
  timeout?: number;
}

interface NodeAttemptCycleResult {
  last: NodeAttemptResult;
  result?: RuntimeNodeResult;
}

type RetryReason = "exit_nonzero" | "gate_failure" | "timeout";

type NodeStateEvent =
  | { at: string; attempt: number; type: "NODE_STARTED" }
  | { at: string; type: "NODE_READY" }
  | {
      at: string;
      exitCode: number;
      output: string;
      type: "NODE_OUTPUT";
    }
  | { at: string; type: "GATES_STARTED" }
  | { at: string; gates: RuntimeGateResult[]; type: "GATES_FINISHED" }
  | { at: string; result: RuntimeNodeResult; type: "NODE_PASSED" }
  | {
      at: string;
      failure: RuntimeFailure;
      result: RuntimeNodeResult;
      type: "NODE_FAILED";
    }
  | { at: string; failure: RuntimeFailure; type: "NODE_CANCELLED" }
  | { at: string; reason: string; type: "NODE_SKIPPED" };

interface JsonSchemaValidationResult {
  evidence: string[];
  passed: boolean;
  reason?: string;
}

interface OutputRepairContext {
  evidence: string[];
  maxAttempts: number;
  runner: string;
  schemaPath: string;
  validation: JsonSchemaValidationResult;
}

export async function runPipelineFromConfig(
  options: PipelineRuntimeOptions
): Promise<PipelineRuntimeResult> {
  const context = createRuntimeContext(options);
  const nodes: RuntimeNodeResult[] = [];

  emitWorkflowPlanned(context);
  emit(context, {
    nodeIds: context.plan.topologicalOrder.map((node) => node.id),
    type: "workflow.start",
    workflowId: context.workflowId,
  });

  const startFailure = await workflowStartFailure(context, nodes);
  if (startFailure) {
    return finishRuntime(context, startFailure);
  }

  const executionFailure = await executeWorkflowBatches(context, nodes);
  if (executionFailure) {
    return finishRuntime(context, executionFailure);
  }

  return finishRuntime(context, await successfulRuntimeResult(context, nodes));
}

function createRuntimeContext(options: PipelineRuntimeOptions): RuntimeContext {
  const worktreePath = options.worktreePath ?? process.cwd();
  const config = options.config ?? loadPipelineConfig(worktreePath);
  const workflowSelection = resolveWorkflowSelection(
    config,
    options.workflowId,
    options.entrypoint
  );
  const plan = compileWorkflowPlan(config, workflowSelection);
  const workflowId = plan.workflowId;
  return {
    agentInvocations: [],
    config,
    executor: options.executor ?? runLaunchPlan,
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: options.hookPolicy?.allowCommandHooks ?? true,
      allowUntrustedCommandHooks:
        options.hookPolicy?.allowUntrustedCommandHooks ?? true,
      env: options.hookPolicy?.env ?? {},
      envPassthrough: options.hookPolicy?.envPassthrough ?? ["PATH"],
      outputLimitBytes:
        options.hookPolicy?.outputLimitBytes ?? DEFAULT_HOOK_OUTPUT_LIMIT_BYTES,
      timeoutMs: options.hookPolicy?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    lastOutputByNode: new Map(),
    maxParallelNodes: runtimeMaxParallelNodes(options, plan),
    nodeSnapshots: new Map(),
    nodeStates: initialNodeStates(plan),
    plan,
    ...(options.reporter ? { reporter: options.reporter } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    task: options.task,
    ...(options.taskContext ? { taskContext: options.taskContext } : {}),
    workflowId,
    worktreePath,
  };
}

function runtimeMaxParallelNodes(
  options: PipelineRuntimeOptions,
  plan: WorkflowExecutionPlan
): number | undefined {
  if (options.maxParallelNodes) {
    return normalizeMaxParallelNodes(options.maxParallelNodes);
  }
  if (plan.execution.maxParallelNodes) {
    return normalizeMaxParallelNodes(plan.execution.maxParallelNodes);
  }
  return;
}

function normalizeMaxParallelNodes(value: number): number {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error("maxParallelNodes must be a positive integer");
  }
  return value;
}

async function workflowStartFailure(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): Promise<PipelineRuntimeResult | null> {
  if (isCancelled(context)) {
    return cancelledRuntimeResult(context, nodes);
  }

  const startHook = await dispatchHooks(context, "workflow.start");
  if (isCancelled(context)) {
    return cancelledRuntimeResult(context, nodes);
  }
  if (startHook) {
    return failedRuntimeResult(context, nodes, startHook);
  }
  return null;
}

async function executeWorkflowBatches(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): Promise<PipelineRuntimeResult | null> {
  for (const batch of context.plan.parallelBatches) {
    if (isCancelled(context)) {
      return cancelledRuntimeResult(context, nodes);
    }
    const results = await executeWorkflowBatch(batch, context);
    nodes.push(...results);
    if (isCancelled(context)) {
      return cancelledRuntimeResult(context, nodes);
    }
    const failed = results.find((result) => result.status === "failed");
    if (failed) {
      const failure = nodeRuntimeFailure(failed);
      await dispatchHooks(context, "workflow.failure", failure);
      await dispatchHooks(context, "workflow.complete", failure);
      return failedRuntimeResult(context, nodes, failure);
    }
  }
  return null;
}

function executeWorkflowBatch(
  batch: PlannedWorkflowNode[],
  context: RuntimeContext
): Promise<RuntimeNodeResult[]> {
  for (const node of batch) {
    transitionNode(context, node.id, { at: now(), type: "NODE_READY" });
  }
  if (context.plan.execution.failFast) {
    return executeFailFastWorkflowBatch(batch, context);
  }
  if (!context.maxParallelNodes) {
    return Promise.all(batch.map((node) => executeNode(node, context)));
  }
  const limit = pLimit(context.maxParallelNodes);
  return Promise.all(
    batch.map((node) => limit(() => executeNode(node, context)))
  );
}

async function executeFailFastWorkflowBatch(
  batch: PlannedWorkflowNode[],
  context: RuntimeContext
): Promise<RuntimeNodeResult[]> {
  const results: RuntimeNodeResult[] = [];
  for (const [index, node] of batch.entries()) {
    const result = await executeNode(node, context);
    results.push(result);
    if (result.status === "failed") {
      skipRemainingBatchNodes(batch, index + 1, context, result.nodeId);
      return results;
    }
  }
  return results;
}

function skipRemainingBatchNodes(
  batch: PlannedWorkflowNode[],
  startIndex: number,
  context: RuntimeContext,
  failedNodeId: string
): void {
  const reason = `skipped because workflow fail_fast stopped after node '${failedNodeId}' failed`;
  for (const node of batch.slice(startIndex)) {
    transitionNode(context, node.id, {
      at: now(),
      reason,
      type: "NODE_SKIPPED",
    });
  }
}

async function successfulRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): Promise<PipelineRuntimeResult> {
  const successHook = await dispatchHooks(context, "workflow.success");
  const completeHook = await dispatchHooks(context, "workflow.complete");
  if (isCancelled(context)) {
    return cancelledRuntimeResult(context, nodes);
  }
  const hookFailure = successHook ?? completeHook;
  if (hookFailure) {
    return failedRuntimeResult(context, nodes, hookFailure);
  }
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "PASS",
    plan: context.plan,
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

function resolveWorkflowSelection(
  config: PipelineConfig,
  workflowId?: string,
  entrypointId?: string
): string | undefined {
  if (workflowId) {
    return workflowId;
  }
  if (!entrypointId) {
    return;
  }
  const entrypoint = config.entrypoints[entrypointId];
  if (!entrypoint) {
    throw new Error(`Unknown pipeline entrypoint '${entrypointId}'`);
  }
  return entrypoint.workflow;
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
  };
}

function runtimeNodeStates(
  context: RuntimeContext
): Record<string, NodeExecutionState> {
  return Object.fromEntries(context.nodeStates);
}

function cancelledFailure(): RuntimeFailure {
  return {
    evidence: ["pipeline cancelled by AbortSignal"],
    gate: "cancelled",
    reason: "pipeline cancelled",
  };
}

function initialNodeStates(
  plan: WorkflowExecutionPlan
): Map<string, NodeExecutionState> {
  return new Map(
    plan.topologicalOrder.map((node) => [
      node.id,
      {
        attempts: 0,
        evidence: [],
        gates: [],
        id: node.id,
        status: "pending",
      },
    ])
  );
}

function transitionNode(
  context: RuntimeContext,
  nodeId: string,
  event: NodeStateEvent
): void {
  const current = context.nodeStates.get(nodeId);
  if (!current) {
    return;
  }
  context.nodeStates.set(nodeId, reduceNodeState(current, event));
}

function reduceNodeState(
  state: NodeExecutionState,
  event: NodeStateEvent
): NodeExecutionState {
  return match(event)
    .returnType<NodeExecutionState>()
    .with({ type: "NODE_READY" }, ({ at }) => ({
      ...state,
      startedAt: state.startedAt ? state.startedAt : at,
      status: state.status === "pending" ? "ready" : state.status,
    }))
    .with({ type: "NODE_STARTED" }, ({ at, attempt }) => ({
      ...state,
      attempts: attempt,
      startedAt: state.startedAt ? state.startedAt : at,
      status: "running",
    }))
    .with({ type: "NODE_OUTPUT" }, ({ exitCode, output }) => ({
      ...state,
      exitCode,
      output,
    }))
    .with({ type: "GATES_STARTED" }, () => ({
      ...state,
      status: "gating",
    }))
    .with({ type: "GATES_FINISHED" }, ({ gates }) => ({
      ...state,
      gates,
    }))
    .with({ type: "NODE_PASSED" }, ({ at, result }) => ({
      ...state,
      attempts: result.attempts,
      evidence: result.evidence,
      exitCode: result.exitCode,
      finishedAt: at,
      output: result.output,
      status: "passed",
    }))
    .with({ type: "NODE_FAILED" }, ({ at, failure, result }) => ({
      ...state,
      attempts: result.attempts,
      evidence: result.evidence,
      exitCode: result.exitCode,
      failure,
      finishedAt: at,
      output: result.output,
      status: "failed",
    }))
    .with({ type: "NODE_CANCELLED" }, ({ at, failure }) => ({
      ...state,
      failure,
      finishedAt: at,
      status: "cancelled",
    }))
    .with({ type: "NODE_SKIPPED" }, ({ at, reason }) => ({
      ...state,
      failure: {
        evidence: [reason],
        gate: state.id,
        nodeId: state.id,
        reason,
      },
      finishedAt: at,
      status: "skipped",
    }))
    .exhaustive();
}

function now(): string {
  return new Date().toISOString();
}

function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
}

function emitWorkflowFinish(
  context: RuntimeContext,
  outcome: PipelineRuntimeResult["outcome"]
): void {
  emit(context, {
    outcome,
    type: "workflow.finish",
    workflowId: context.workflowId,
  });
}

function emitWorkflowPlanned(context: RuntimeContext): void {
  emit(context, {
    edges: context.plan.topologicalOrder.flatMap((node) =>
      node.needs.map((source) => ({
        source,
        target: node.id,
      }))
    ),
    nodes: context.plan.topologicalOrder.map((node) => {
      const planned = {
        id: node.id,
        kind: node.kind,
        needs: node.needs,
      } as {
        id: string;
        kind: PlannedWorkflowNode["kind"];
        needs: string[];
        profile?: string;
        runnerId?: string;
      };
      if (node.profile) {
        planned.profile = node.profile;
        const profile = context.config.profiles[node.profile];
        if (profile?.runner) {
          planned.runnerId = profile.runner;
        }
      }
      return planned;
    }),
    type: "workflow.planned",
    workflowId: context.workflowId,
  });
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

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    const cycle = await executeNodeAttemptCycle(
      node,
      context,
      attempt,
      retryPolicy,
      last
    );
    last = cycle.last;
    if (cycle.result) {
      emitNodeFinish(context, cycle.result);
      return cycle.result;
    }
  }

  const result = nodeFailure(
    node.id,
    retryPolicy.maxAttempts,
    last.evidence,
    last.output
  );
  emitNodeFinish(context, result);
  return result;
}

interface NodeRetryPolicy {
  backoffMs: number;
  maxAttempts: number;
  multiplier: number;
  retryOn: Set<RetryReason>;
}

function nodeRetryPolicy(node: PlannedWorkflowNode): NodeRetryPolicy {
  const retryOn = new Set<RetryReason>([
    "exit_nonzero",
    "gate_failure",
    "timeout",
  ]);
  if (node.retries?.retry_on) {
    retryOn.clear();
    for (const reason of node.retries.retry_on) {
      retryOn.add(reason);
    }
  }
  return {
    backoffMs: node.retries?.backoff_ms ? node.retries.backoff_ms : 0,
    maxAttempts: node.retries?.max_attempts ? node.retries.max_attempts : 1,
    multiplier: node.retries?.multiplier ? node.retries.multiplier : 1,
    retryOn,
  };
}

async function executeNodeAttemptCycle(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  retryPolicy: NodeRetryPolicy,
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
  transitionNode(context, node.id, {
    at: now(),
    attempt,
    type: "NODE_STARTED",
  });
  const startHook = await dispatchHooks(context, "node.start", undefined, node);
  if (startHook) {
    const result = nodeFailure(
      node.id,
      attempt,
      startHook.evidence,
      previous.output
    );
    transitionNode(context, node.id, {
      at: now(),
      failure: nodeRuntimeFailure(result),
      result,
      type: "NODE_FAILED",
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

  context.nodeSnapshots.set(
    node.id,
    await snapshotChangedFiles(context.worktreePath)
  );
  const last = await executeNodeAttempt(node, context, attempt);
  transitionNode(context, node.id, {
    at: now(),
    exitCode: last.exitCode,
    output: last.output,
    type: "NODE_OUTPUT",
  });
  const afterSnapshot = await snapshotChangedFiles(context.worktreePath);
  const beforeSnapshot = context.nodeSnapshots.get(node.id);
  if (beforeSnapshot) {
    context.nodeSnapshots.set(
      node.id,
      diffChangedFiles(beforeSnapshot, afterSnapshot)
    );
  }
  context.lastOutputByNode.set(node.id, last.output);
  emitNodeOutputRecorded(context, node, attempt, last.output);
  const cancelledAfterAttempt = cancelledNodeResult(
    context,
    node.id,
    attempt,
    last
  );
  if (cancelledAfterAttempt) {
    return { last, result: cancelledAfterAttempt };
  }

  transitionNode(context, node.id, { at: now(), type: "GATES_STARTED" });
  const gateResults = await evaluateNodeGates(node, context, last);
  transitionNode(context, node.id, {
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
      transitionNode(context, node.id, {
        at: now(),
        failure: nodeRuntimeFailure(result),
        result,
        type: "NODE_FAILED",
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
    transitionNode(context, node.id, {
      at: now(),
      result,
      type: "NODE_PASSED",
    });
    return { last, result };
  }

  const evidence = failedGate
    ? [...last.evidence, ...failedGate.evidence]
    : last.evidence.concat(`node exited with code ${last.exitCode}`);
  const retryReason = nodeRetryReason(last, failedGate);
  if (
    attempt === retryPolicy.maxAttempts ||
    !retryPolicy.retryOn.has(retryReason)
  ) {
    await dispatchHooks(
      context,
      "node.error",
      {
        evidence,
        gate: failedGate?.gateId ?? node.id,
        nodeId: node.id,
        reason: failedGate?.reason ?? `node exited with code ${last.exitCode}`,
      },
      node
    );
    const result = nodeFailure(node.id, attempt, evidence, last.output);
    transitionNode(context, node.id, {
      at: now(),
      failure: nodeRuntimeFailure(result),
      result,
      type: "NODE_FAILED",
    });
    return { last, result };
  }

  await waitBeforeRetry(context, retryPolicy, attempt);
  return { last };
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

async function waitBeforeRetry(
  context: RuntimeContext,
  retryPolicy: NodeRetryPolicy,
  attempt: number
): Promise<void> {
  const duration = retryBackoffDuration(retryPolicy, attempt);
  if (duration <= 0) {
    return;
  }
  await sleep(duration, context.signal);
}

function retryBackoffDuration(
  retryPolicy: NodeRetryPolicy,
  attempt: number
): number {
  if (retryPolicy.backoffMs === 0) {
    return 0;
  }
  return Math.round(
    retryPolicy.backoffMs * retryPolicy.multiplier ** (attempt - 1)
  );
}

function sleep(duration: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, duration);
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
  transitionNode(context, nodeId, {
    at: now(),
    failure: cancelledFailure(),
    type: "NODE_CANCELLED",
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

async function snapshotChangedFiles(
  worktreePath: string
): Promise<ChangedFilesSnapshot> {
  try {
    const status = await simpleGit({ baseDir: worktreePath }).status();
    return {
      files: new Set(status.files.map((file) => file.path).filter(Boolean)),
    };
  } catch {
    return { files: new Set() };
  }
}

function diffChangedFiles(
  before: ChangedFilesSnapshot,
  after: ChangedFilesSnapshot
): ChangedFilesSnapshot {
  return {
    files: new Set([...after.files].filter((file) => !before.files.has(file))),
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
      return executeBuiltin(node.builtin ?? "", context);
    case "group":
      return {
        evidence: [`group '${node.id}' completed`],
        exitCode: 0,
        output: "",
      };
    default: {
      const _exhaustive: never = node.kind;
      throw new Error(`Unsupported node kind: ${String(_exhaustive)}`);
    }
  }
}

async function executeAgentNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Promise<NodeAttemptResult> {
  if (!node.profile) {
    return {
      evidence: [`node '${node.id}' has no profile`],
      exitCode: 1,
      output: "",
    };
  }
  const prompt = renderAgentPrompt(node, context);
  const plan = createRunnerLaunchPlan(context.config, {
    nodeId: node.id,
    profileId: node.profile,
    prompt,
    worktreePath: context.worktreePath,
  });
  if (node.timeoutMs) {
    plan.timeoutMs = node.timeoutMs;
  }
  context.agentInvocations.push(plan);
  emitAgentStart(context, plan, attempt);
  const result = await context.executor(plan, { signal: context.signal });
  emitAgentFinish(context, plan, attempt, result);
  const normalized = normalizeAgentOutput(plan, result.stdout);
  const finalized = await finalizeAgentOutput({
    context,
    node,
    normalized,
    result,
    attempt,
  });
  return {
    evidence: [
      `agent boundary node=${node.id} profile=${node.profile} runner=${plan.runnerId} strategy=${plan.strategy}`,
      ...finalized.evidence,
      ...(result.stderr ? [`stderr: ${result.stderr}`] : []),
      ...(result.timedOut ? ["agent timed out"] : []),
    ],
    exitCode: result.exitCode,
    output: finalized.output,
    timedOut: result.timedOut,
  };
}

async function finalizeAgentOutput(inputs: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  normalized: { evidence: string[]; output: string };
  result: AgentResult;
}): Promise<{ evidence: string[]; output: string }> {
  const { attempt, context, node, normalized, result } = inputs;
  const repairContext = outputRepairContext(context, node, normalized, result);
  if (!repairContext) {
    return normalized;
  }

  return await runOutputRepair(
    context,
    node,
    normalized,
    repairContext,
    attempt
  );
}

function outputRepairContext(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  result: AgentResult
): OutputRepairContext | null {
  if (result.exitCode !== 0 || result.timedOut) {
    return null;
  }
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  if (!profile) {
    return null;
  }
  const output = profile?.output;
  if (output?.format !== "json_schema" || !output.schema_path) {
    return null;
  }
  const firstValidation = validateJsonSchemaSource(
    normalized.output,
    output.schema_path,
    context.worktreePath
  );
  if (firstValidation.passed) {
    return null;
  }
  const repair = outputRepairOptions(output);
  if (!repair.enabled) {
    return null;
  }
  return {
    evidence: [
      ...normalized.evidence,
      "output repair triggered",
      ...firstValidation.evidence.map((item) => `original output: ${item}`),
    ],
    maxAttempts: repair.maxAttempts,
    runner: repair.runner ?? profile.runner,
    schemaPath: output.schema_path,
    validation: firstValidation,
  };
}

async function runOutputRepair(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  repairContext: OutputRepairContext,
  nodeAttempt: number
): Promise<{ evidence: string[]; output: string }> {
  let latest = normalized;
  let latestValidation = repairContext.validation;
  const evidence = [...repairContext.evidence];
  for (let attempt = 1; attempt <= repairContext.maxAttempts; attempt += 1) {
    const repairPlan = createOutputRepairPlan({
      context,
      node,
      originalOutput: latest.output,
      repairRunner: repairContext.runner,
      schemaPath: repairContext.schemaPath,
      validation: latestValidation,
    });
    context.agentInvocations.push(repairPlan);
    emitAgentStart(context, repairPlan, nodeAttempt);
    const repairResult = await context.executor(repairPlan, {
      signal: context.signal,
    });
    emitAgentFinish(context, repairPlan, nodeAttempt, repairResult);
    const repaired = normalizeAgentOutput(repairPlan, repairResult.stdout);
    const repairedValidation = validateJsonSchemaSource(
      repaired.output,
      repairContext.schemaPath,
      context.worktreePath
    );
    latest = {
      evidence: [
        ...repaired.evidence,
        ...(repairResult.stderr
          ? [`repair stderr: ${repairResult.stderr}`]
          : []),
        ...(repairResult.timedOut ? ["output repair timed out"] : []),
      ],
      output: repaired.output,
    };
    latestValidation = repairedValidation;
    const passed = repairResult.exitCode === 0 && repairedValidation.passed;
    evidence.push(
      ...repaired.evidence,
      passed
        ? `output repair passed for ${node.id} after attempt ${attempt}`
        : `output repair failed for ${node.id} after attempt ${attempt}`,
      ...repairedValidation.evidence.map((item) => `repaired output: ${item}`)
    );
    emit(context, {
      attempt,
      nodeId: node.id,
      passed,
      type: "output.repair",
      ...(passed
        ? {}
        : { reason: repairedValidation.reason ?? "repair failed" }),
    });
    if (passed) {
      return {
        evidence,
        output: repaired.output,
      };
    }
  }

  return {
    evidence,
    output: latest.output,
  };
}

function outputRepairOptions(
  output: NonNullable<PipelineConfig["profiles"][string]["output"]>
): { enabled: boolean; maxAttempts: number; runner?: string } {
  const repair = output.repair;
  return {
    enabled: repair?.enabled ?? true,
    maxAttempts: repair?.max_attempts ?? 1,
    ...(repair?.runner ? { runner: repair.runner } : {}),
  };
}

function createOutputRepairPlan(inputs: {
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  originalOutput: string;
  repairRunner: string;
  schemaPath: string;
  validation: JsonSchemaValidationResult;
}): RunnerLaunchPlan {
  const {
    context,
    node,
    originalOutput,
    repairRunner,
    schemaPath,
    validation,
  } = inputs;
  const schema = readFileSync(join(context.worktreePath, schemaPath), "utf8");
  const repairProfileId = `${node.id}:output-repair`;
  const repairConfig: PipelineConfig = {
    ...context.config,
    profiles: {
      ...context.config.profiles,
      [repairProfileId]: {
        filesystem: { mode: "read-only" },
        instructions: { inline: "Repair invalid structured output." },
        network: { mode: "disabled" },
        output: { format: "text" },
        runner: repairRunner,
        tools: [],
      },
    },
  };
  const prompt = [
    "You are an output finalizer for a pipeline agent.",
    "Return only valid JSON matching the expected schema.",
    "Do not use Markdown fences or add prose outside the JSON value.",
    "Preserve facts from the original output. If required information is missing, use empty arrays or nulls only where the schema permits.",
    "",
    "Expected schema:",
    schema,
    "",
    "Validation error:",
    validation.evidence.join("\n"),
    "",
    "Original output:",
    originalOutput,
  ].join("\n");
  return createRunnerLaunchPlan(repairConfig, {
    nodeId: repairProfileId,
    profileId: repairProfileId,
    prompt,
    worktreePath: context.worktreePath,
  });
}

function normalizeAgentOutput(
  plan: RunnerLaunchPlan,
  stdout: string
): { evidence: string[]; output: string } {
  if (plan.type === "codex") {
    const text = lastJsonLineValue(stdout, (value) => {
      if (!isRecord(value)) {
        return;
      }
      const item = value.item;
      if (isRecord(item) && item.type === "agent_message") {
        return typeof item.text === "string" ? item.text : undefined;
      }
      if (value.type === "agent_message") {
        return typeof value.text === "string" ? value.text : undefined;
      }
    });
    if (text) {
      return {
        evidence: ["normalized runner output from codex JSONL"],
        output: text,
      };
    }
  }

  if (plan.type === "opencode") {
    const text = lastJsonLineValue(stdout, (value) => {
      if (!isRecord(value)) {
        return;
      }
      const part = value.part;
      if (isRecord(part) && part.type === "text") {
        return typeof part.text === "string" ? part.text : undefined;
      }
    });
    if (text) {
      return {
        evidence: ["normalized runner output from opencode JSON events"],
        output: text,
      };
    }
  }

  return { evidence: [], output: stdout };
}

function lastJsonLineValue(
  text: string,
  extract: (value: unknown) => string | undefined
): string | undefined {
  let latest: string | undefined;
  for (const line of text.split(LINE_RE)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const extracted = extract(JSON.parse(trimmed));
      if (extracted) {
        latest = extracted;
      }
    } catch {
      // Non-JSON lines are valid for non-event runner output.
    }
  }
  return latest;
}

function renderAgentPrompt(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): string {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  const instructions = profile
    ? readInstructions(context.worktreePath, profile.instructions)
    : "";
  return [
    instructions.trim(),
    "",
    `Task: ${context.task}`,
    `Workflow: ${context.workflowId}`,
    `Node: ${node.id}`,
    node.profile ? `Profile: ${node.profile}` : "",
    renderTaskContext(context.taskContext),
    "",
    "Declared grants:",
    `- tools: ${(profile?.tools ?? []).join(", ") || "none"}`,
    `- rules: ${(profile?.rules ?? []).join(", ") || "none"}`,
    `- skills: ${(profile?.skills ?? []).join(", ") || "none"}`,
    `- mcp_servers: ${(profile?.mcp_servers ?? []).join(", ") || "none"}`,
    renderPathReferences(
      "Loaded rules",
      profile?.rules,
      context.config.rules,
      context.worktreePath
    ),
    renderPathReferences(
      "Loaded skills",
      profile?.skills,
      context.config.skills,
      context.worktreePath
    ),
    renderMcpReferences(profile?.mcp_servers, context.config.mcp_servers),
    "",
    "Dependency outputs:",
    ...node.needs.map(
      (need) => `## ${need}\n${context.lastOutputByNode.get(need) ?? ""}`
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function renderTaskContext(
  taskContext: PipelineTaskContext | undefined
): string {
  if (!taskContext) {
    return "";
  }
  const acceptance = taskContext.acceptanceCriteria ?? [];
  return [
    "",
    "Canonical task context:",
    taskContext.id ? `ID: ${taskContext.id}` : "",
    taskContext.title ? `Title: ${taskContext.title}` : "",
    taskContext.description ? `Description: ${taskContext.description}` : "",
    acceptance.length ? "Acceptance criteria:" : "",
    ...acceptance.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function readInstructions(
  worktreePath: string,
  instructions: PipelineConfig["profiles"][string]["instructions"]
): string {
  if (instructions.inline) {
    return instructions.inline;
  }
  if (instructions.path) {
    return readFileSync(join(worktreePath, instructions.path), "utf8");
  }
  return "";
}

function renderPathReferences(
  heading: string,
  ids: string[] | undefined,
  registry: Record<string, { path: string }>,
  worktreePath: string
): string {
  if (!ids?.length) {
    return "";
  }
  return [
    "",
    `${heading}:`,
    ...ids.map((id) => {
      const ref = registry[id];
      const path = ref?.path ?? "";
      const content = readFileSync(join(worktreePath, path), "utf8").trimEnd();
      return [`## ${id}`, `Path: ${path}`, "", content].join("\n");
    }),
  ].join("\n");
}

function renderMcpReferences(
  ids: string[] | undefined,
  registry: PipelineConfig["mcp_servers"]
): string {
  if (!ids?.length) {
    return "";
  }
  return [
    "",
    "Loaded MCP servers:",
    ...ids.map((id) => {
      const server = registry[id];
      if (server?.url) {
        return [
          `## ${id}`,
          "transport: http",
          `url: ${server.url}`,
          `headers: ${Object.keys(server.headers ?? {}).join(", ") || "none"}`,
          `bearer_token_env_var: ${server.bearer_token_env_var ?? "none"}`,
        ].join("\n");
      }
      return [
        `## ${id}`,
        "transport: stdio",
        `command: ${server?.command ?? ""}`,
        `args: ${(server?.args ?? []).join(" ") || "none"}`,
        `env: ${Object.keys(server?.env ?? {}).join(", ") || "none"}`,
      ].join("\n");
    }),
  ].join("\n");
}

async function executeCommand(
  command: string[],
  context: RuntimeContext,
  options: CommandExecutionOptions = {}
): Promise<NodeAttemptResult> {
  if (command.length === 0) {
    return { evidence: ["empty command"], exitCode: 1, output: "" };
  }
  try {
    const result = await execa(command[0] as string, command.slice(1), {
      cancelSignal: context.signal,
      cwd: context.worktreePath,
      ...(options.env ? { env: options.env } : {}),
      ...(options.extendEnv === false ? { extendEnv: false } : {}),
      ...(options.input ? { input: options.input } : {}),
      ...(options.outputLimitBytes
        ? { maxBuffer: options.outputLimitBytes }
        : {}),
      timeout: options.timeout,
    });
    const output = limitOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
      options.outputLimitBytes
    );
    return {
      evidence: [
        `command exited ${result.exitCode ?? 0}: ${command.join(" ")}`,
        ...output.evidence,
      ],
      exitCode: result.exitCode ?? 0,
      output: output.text,
    };
  } catch (err) {
    const e = err as {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    const output = limitOutput(
      [e.stdout, e.stderr].filter(Boolean).join("\n"),
      options.outputLimitBytes
    );
    return {
      evidence: [
        `command exited ${e.exitCode ?? 1}: ${command.join(" ")}`,
        ...(e.timedOut ? ["command timed out"] : []),
        ...output.evidence,
        output.text,
      ].filter(Boolean),
      exitCode: e.exitCode ?? 1,
      output: output.text,
      timedOut: Boolean(e.timedOut),
    };
  }
}

function limitOutput(
  text: string,
  limitBytes?: number
): { evidence: string[]; text: string } {
  if (!limitBytes || Buffer.byteLength(text, "utf8") <= limitBytes) {
    return { evidence: [], text };
  }
  const truncated = Buffer.from(text, "utf8")
    .subarray(0, limitBytes)
    .toString("utf8");
  return {
    evidence: [
      `command output truncated to ${limitBytes} bytes from ${Buffer.byteLength(
        text,
        "utf8"
      )} bytes`,
    ],
    text: truncated,
  };
}

async function executeBuiltin(
  builtin: string,
  context: RuntimeContext
): Promise<NodeAttemptResult> {
  switch (builtin) {
    case "test": {
      const result = await runTests(context.worktreePath, context.signal);
      return {
        evidence: [result.output, ...result.failingTests],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "typecheck": {
      const result = await runTypecheck(context.worktreePath, context.signal);
      return {
        evidence: [result.output],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "duplication": {
      const result = await runJscpd(context.worktreePath, context.signal);
      return {
        evidence: result.violations.map((violation) => violation.message),
        exitCode: result.violations.length === 0 ? 0 : 1,
        output: JSON.stringify(result.violations),
      };
    }
    default:
      return {
        evidence: [`unsupported builtin '${builtin}'`],
        exitCode: 1,
        output: "",
      };
  }
}

async function evaluateNodeGates(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): Promise<RuntimeGateResult[]> {
  const results: RuntimeGateResult[] = [];
  for (const gate of nodeGateSpecs(node, context)) {
    const gateId = gate.id ?? `${gate.kind}:${node.id}`;
    if (isCancelled(context)) {
      break;
    }
    emitGateStart(context, node.id, gate, gateId);
    const result = await evaluateGate(gate, node.id, context, attempt);
    context.gates.push(result);
    results.push(result);
    emitGateFinish(context, gate, result);
    if (!result.passed) {
      await dispatchGateFailureHook(context, node, result);
      if (gate.required !== false) {
        break;
      }
    }
  }
  return results;
}

function nodeGateSpecs(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] {
  return [
    ...(node.gates ?? []),
    ...artifactGateSpecs(node),
    ...schemaGateSpecs(node, context),
  ];
}

function artifactGateSpecs(node: PlannedWorkflowNode): GateSpec[] {
  return (node.artifacts ?? []).map(
    (artifact): GateSpec => ({
      id: `artifact:${artifact.path}`,
      kind: "artifact",
      path: artifact.path,
      required: artifact.required,
    })
  );
}

function schemaGateSpecs(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  if (
    profile?.output?.format !== "json_schema" ||
    !profile.output.schema_path
  ) {
    return [];
  }
  return [
    {
      id: `output:${node.id}`,
      kind: "json_schema",
      schema_path: profile.output.schema_path,
      target: "stdout",
    },
  ];
}

function emitGateStart(
  context: RuntimeContext,
  nodeId: string,
  gate: GateSpec,
  gateId: string
): void {
  emit(context, {
    gateId,
    kind: gate.kind,
    nodeId,
    type: "gate.start",
  });
  if (gate.kind === "artifact") {
    emit(context, {
      nodeId,
      path: gate.path ?? "",
      required: gate.required !== false,
      type: "artifact.check.start",
    });
  }
}

function emitGateFinish(
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult
): void {
  if (gate.kind === "artifact") {
    emit(context, {
      nodeId: result.nodeId,
      passed: result.passed,
      path: gate.path ?? "",
      required: gate.required !== false,
      type: "artifact.check.finish",
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }
  emit(context, {
    evidence: result.evidence,
    gateId: result.gateId,
    kind: result.kind,
    nodeId: result.nodeId,
    passed: result.passed,
    type: "gate.finish",
    ...(result.reason ? { reason: result.reason } : {}),
  });
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

function emit(context: RuntimeContext, event: PipelineRuntimeEvent): void {
  context.reporter?.(event);
}

function emitNodeStart(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  attempt: number
): void {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  emit(context, {
    attempt,
    nodeId: node.id,
    type: "node.start",
    ...(node.profile ? { profile: node.profile } : {}),
    ...(profile?.runner ? { runnerId: profile.runner } : {}),
  });
}

function emitNodeFinish(
  context: RuntimeContext,
  result: RuntimeNodeResult
): void {
  const node = context.plan.topologicalOrder.find(
    (item) => item.id === result.nodeId
  );
  const profile = node?.profile
    ? context.config.profiles[node.profile]
    : undefined;
  emit(context, {
    attempt: result.attempts,
    exitCode: result.exitCode,
    nodeId: result.nodeId,
    ...(node?.profile ? { profile: node.profile } : {}),
    ...(profile?.runner ? { runnerId: profile.runner } : {}),
    status: result.status,
    type: "node.finish",
  });
}

function emitNodeOutputRecorded(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  attempt: number,
  output: string
): void {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  const format = profile?.output?.format ? profile.output.format : "text";
  const parsed = parseRuntimeOutput(format, output);
  const event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }> =
    {
      attempt,
      format,
      nodeId: node.id,
      output: parsed.output,
      type: "node.output.recorded",
    };
  if (node.profile) {
    event.profile = node.profile;
  }
  if (profile?.output?.schema_path) {
    event.schemaPath = profile.output.schema_path;
  }
  if (parsed.error) {
    event.parseError = parsed.error;
  }
  emit(context, event);
}

function parseRuntimeOutput(
  format: string,
  output: string
): { error?: string; output: unknown } {
  if (!(format === "json" || format === "json_schema" || format === "jsonl")) {
    return { output };
  }
  try {
    if (format === "jsonl") {
      return {
        output: output
          .split(LINE_RE)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line)),
      };
    }
    return { output: JSON.parse(output) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "failed to parse output",
      output,
    };
  }
}

function emitAgentStart(
  context: RuntimeContext,
  plan: RunnerLaunchPlan,
  attempt: number
): void {
  emit(context, {
    attempt,
    nodeId: plan.nodeId,
    type: "agent.start",
    ...(plan.profileId ? { profile: plan.profileId } : {}),
    runnerId: plan.runnerId,
  });
}

function emitAgentFinish(
  context: RuntimeContext,
  plan: RunnerLaunchPlan,
  attempt: number,
  result: AgentResult
): void {
  emit(context, {
    attempt,
    exitCode: result.exitCode,
    nodeId: plan.nodeId,
    type: "agent.finish",
    ...(plan.profileId ? { profile: plan.profileId } : {}),
    runnerId: plan.runnerId,
  });
}

function evaluateGate(
  gate: GateSpec,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): RuntimeGateResult | Promise<RuntimeGateResult> {
  const gateId = gate.id ?? `${gate.kind}:${nodeId}`;
  switch (gate.kind) {
    case "command":
      return evaluateCommandGate(gate, gateId, nodeId, context);
    case "artifact":
      return evaluateArtifactGate(gate, gateId, nodeId, context);
    case "builtin":
      return evaluateBuiltinGate(gate, gateId, nodeId, context);
    case "verdict":
      return evaluateVerdictGate(gate, gateId, nodeId, context, attempt);
    case "acceptance":
      return evaluateAcceptanceGate(gate, gateId, nodeId, context, attempt);
    case "changed_files":
      return evaluateChangedFilesGate(gate, gateId, nodeId, context);
    case "json_schema":
      return evaluateJsonSchemaGate(gate, gateId, nodeId, context, attempt);
    default:
      return assertNever(gate);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported gate kind: ${String(value)}`);
}

async function evaluateCommandGate(
  gate: CommandGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): Promise<RuntimeGateResult> {
  const result = await executeCommand(gate.command ?? [], context, {
    timeout: gate.timeout_ms,
  });
  const expected = gate.expect_exit_code ?? 0;
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.exitCode === expected,
    reason:
      result.exitCode === expected
        ? undefined
        : `expected exit ${expected}, got ${result.exitCode}`,
  };
}

function evaluateArtifactGate(
  gate: ArtifactGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): RuntimeGateResult {
  const path = gate.path ?? "";
  const passed = Boolean(path) && artifactExists(context.worktreePath, path);
  return {
    evidence: [
      passed ? `artifact exists: ${path}` : `missing artifact: ${path}`,
    ],
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : `missing artifact '${path}'`,
  };
}

async function evaluateBuiltinGate(
  gate: BuiltinGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): Promise<RuntimeGateResult> {
  const result = await executeBuiltin(gate.builtin ?? "", context);
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.exitCode === 0,
    reason:
      result.exitCode === 0
        ? undefined
        : `builtin '${gate.builtin ?? ""}' failed`,
  };
}

function gateJsonSource(
  gate: JsonSourceGateSpec,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): { evidence?: string; source?: string } {
  if (gate.target === "artifact") {
    if (!gate.path) {
      return { evidence: "missing JSON artifact path" };
    }
    const source = readOptionalFile(join(context.worktreePath, gate.path));
    return source === null
      ? { evidence: `missing JSON artifact: ${gate.path}` }
      : { source };
  }
  return { source: attempt.output };
}

function parseGateJson(
  gate: JsonSourceGateSpec,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): { evidence?: string; value?: unknown } {
  const source = gateJsonSource(gate, context, attempt);
  if (source.evidence) {
    return { evidence: source.evidence };
  }
  try {
    return { value: JSON.parse(source.source ?? "") };
  } catch (err) {
    return {
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
}

function evaluateVerdictGate(
  gate: VerdictGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): RuntimeGateResult {
  const parsed = parseGateJson(gate, context, attempt);
  const field = gate.field ?? "verdict";
  const expected = gate.equals ?? "PASS";
  if (parsed.evidence) {
    return {
      evidence: [parsed.evidence],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: "verdict gate JSON parse failed",
    };
  }
  const value = isRecord(parsed.value) ? parsed.value[field] : undefined;
  const passed = value === expected;
  return {
    evidence: [
      passed
        ? `verdict '${field}' matched '${expected}'`
        : `verdict '${field}' expected '${expected}', got '${String(value)}'`,
    ],
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "verdict requirement failed",
  };
}

function evaluateAcceptanceGate(
  gate: AcceptanceGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): RuntimeGateResult {
  const expected = context.taskContext?.acceptanceCriteria ?? [];
  if (expected.length === 0) {
    return {
      evidence: ["no acceptance criteria in task context"],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: gate.required === false,
      reason:
        gate.required === false ? undefined : "missing task acceptance context",
    };
  }
  const parsed = parseGateJson(gate, context, attempt);
  if (parsed.evidence) {
    return {
      evidence: [parsed.evidence],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: "acceptance gate JSON parse failed",
    };
  }
  const entries = acceptanceEntries(parsed.value, gate.acceptance_key);
  const evidence = acceptanceCoverageEvidence(expected, entries);
  const passed = evidence.length === 0;
  return {
    evidence: passed ? ["acceptance coverage passed"] : evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "acceptance coverage failed",
  };
}

function acceptanceEntries(
  value: unknown,
  key = "acceptance"
): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const raw = value[key] ?? value.criteria ?? value.acceptanceCriteria;
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function acceptanceCoverageEvidence(
  expected: AcceptanceCriterion[],
  entries: Record<string, unknown>[]
): string[] {
  const evidence: string[] = [];
  const expectedIds = new Set(expected.map((criterion) => criterion.id));
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id) {
      evidence.push("acceptance entry missing id");
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (!expectedIds.has(id)) {
      evidence.push(`extra acceptance criterion '${id}'`);
    }
    const verdict = entry.verdict;
    if (verdict !== "PASS") {
      evidence.push(
        `acceptance criterion '${id}' verdict '${String(verdict)}'`
      );
    }
    const itemEvidence = entry.evidence;
    if (
      verdict === "PASS" &&
      (!Array.isArray(itemEvidence) ||
        itemEvidence.filter((item) => typeof item === "string" && item.trim())
          .length === 0)
    ) {
      evidence.push(`acceptance criterion '${id}' has no evidence`);
    }
  }
  for (const id of expectedIds) {
    const count = seen.get(id) ?? 0;
    if (count === 0) {
      evidence.push(`missing acceptance criterion '${id}'`);
    }
    if (count > 1) {
      evidence.push(`duplicate acceptance criterion '${id}'`);
    }
  }
  return evidence;
}

function evaluateChangedFilesGate(
  gate: ChangedFilesGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): RuntimeGateResult {
  const changed = [...(context.nodeSnapshots.get(nodeId)?.files ?? new Set())];
  const policy = gate.changed_files ?? {};
  const evidence: string[] = [];
  const included =
    policy.include_untracked === false
      ? changed.filter((file) => !file.startsWith("?? "))
      : changed;
  const denied = included.filter((file) =>
    (policy.deny ?? []).some((pattern) => globMatch(pattern, file))
  );
  if (denied.length > 0) {
    evidence.push(`denied changes: ${denied.join(", ")}`);
  }
  const disallowed = included.filter(
    (file) =>
      (policy.allow?.length ?? 0) > 0 &&
      !(policy.allow ?? []).some((pattern) => globMatch(pattern, file))
  );
  if (disallowed.length > 0) {
    evidence.push(`changes outside allow list: ${disallowed.join(", ")}`);
  }
  if (
    (policy.require_any?.length ?? 0) > 0 &&
    !included.some((file) =>
      (policy.require_any ?? []).some((pattern) => globMatch(pattern, file))
    )
  ) {
    evidence.push(
      `missing required changes matching: ${(policy.require_any ?? []).join(", ")}`
    );
  }
  const passed = evidence.length === 0;
  return {
    evidence: passed
      ? [`changed files: ${included.join(", ") || "none"}`]
      : evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "changed-file policy failed",
  };
}

function globMatch(pattern: string, value: string): boolean {
  return micromatch.isMatch(value, pattern, { dot: true });
}

function evaluateJsonSchemaGate(
  gate: JsonSchemaGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): RuntimeGateResult {
  const schemaPath = gate.schema_path ?? "";
  const source =
    gate.target === "artifact" && gate.path
      ? readOptionalFile(join(context.worktreePath, gate.path))
      : attempt.output;
  if (source === null) {
    return {
      evidence: [`missing JSON artifact: ${gate.path ?? ""}`],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: `missing JSON artifact '${gate.path ?? ""}'`,
    };
  }
  const result = validateJsonSchemaSource(
    source,
    schemaPath,
    context.worktreePath
  );
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.passed,
    reason: result.reason,
  };
}

function validateJsonSchemaSource(
  source: string,
  schemaPath: string,
  worktreePath: string
): JsonSchemaValidationResult {
  try {
    const schema = JSON.parse(
      readFileSync(join(worktreePath, schemaPath), "utf8")
    );
    const value = JSON.parse(source);
    const validate = jsonSchemaValidator.compile(schema);
    const errors = validate(value)
      ? []
      : formatJsonSchemaErrors(validate.errors ?? []);
    return {
      evidence:
        errors.length === 0
          ? [`JSON schema passed: ${schemaPath}`]
          : errors.map((error) => `schema: ${error}`),
      passed: errors.length === 0,
      reason: errors.length === 0 ? undefined : "JSON schema validation failed",
    };
  } catch (err) {
    return {
      evidence: [err instanceof Error ? err.message : String(err)],
      passed: false,
      reason: "JSON schema validation failed",
    };
  }
}

function readOptionalFile(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function formatJsonSchemaErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath || "$";
    return `${path} ${error.message ?? "failed validation"}`.trim();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dispatchHooks(
  context: RuntimeContext,
  event: HookSpec["event"],
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeFailure | null> {
  for (const hookId of hookIdsForContext(context, node)) {
    if (isCancelled(context)) {
      return null;
    }
    const hook = context.config.hooks[hookId];
    if (!hook || hook.event !== event) {
      continue;
    }
    emitHookStart(context, event, hookId, hook, node, gateId);
    const result = await executeHook(
      hook,
      hookId,
      context,
      failure,
      node,
      gateId
    );
    emitHookFinish(context, event, hookId, hook, result, node, gateId);
    if (result && hook.required === true) {
      context.hookFailures.push(result);
      return result;
    }
    if (result) {
      context.hookFailures.push(result);
    }
  }
  return null;
}

function hookIdsForContext(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): string[] {
  const workflow = context.config.workflows[context.workflowId];
  if (node) {
    return uniqueHookIds([...(workflow?.hooks ?? []), ...(node.hooks ?? [])]);
  }
  return uniqueHookIds([
    ...(context.config.orchestrator.hooks ?? []),
    ...(workflow?.hooks ?? []),
  ]);
}

function uniqueHookIds(hookIds: string[]): string[] {
  return [...new Set(hookIds)];
}

function emitHookStart(
  context: RuntimeContext,
  event: HookSpec["event"],
  hookId: string,
  hook: HookSpec,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  emit(context, {
    event,
    hookId,
    required: hook.required === true,
    type: "hook.start",
    workflowId: context.workflowId,
    ...(node ? { nodeId: node.id } : {}),
    ...(gateId ? { gateId } : {}),
  });
}

function emitHookFinish(
  context: RuntimeContext,
  event: HookSpec["event"],
  hookId: string,
  hook: HookSpec,
  result: RuntimeFailure | null,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  emit(context, {
    event,
    hookId,
    passed: result === null,
    required: hook.required === true,
    type: "hook.finish",
    workflowId: context.workflowId,
    ...(node ? { nodeId: node.id } : {}),
    ...(gateId ? { gateId } : {}),
    ...(result?.reason ? { reason: result.reason } : {}),
  });
}

async function executeHook(
  hook: HookSpec,
  hookId: string,
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeFailure | null> {
  if (hook.enabled === false) {
    return null;
  }
  if (hook.kind === "builtin") {
    if (hook.builtin === "log") {
      return null;
    }
    return {
      evidence: [`unsupported hook builtin '${hook.builtin ?? ""}'`],
      gate: hookId,
      nodeId: node?.id,
      reason: `hook '${hookId}' failed`,
    };
  }
  if (context.hookPolicy.allowCommandHooks === false) {
    return hookPolicyFailure(hookId, node, "command hooks are disabled");
  }
  if (
    hook.trusted === false &&
    context.hookPolicy.allowUntrustedCommandHooks === false
  ) {
    return hookPolicyFailure(hookId, node, "command hook is not trusted");
  }
  const rendered = (hook.command ?? []).map((part) =>
    renderTemplate(part, context, failure, node, gateId)
  );
  const result = await executeCommand(rendered, context, {
    env: hookEnv(hook, context),
    extendEnv: false,
    input: JSON.stringify(hookPayload(context, failure, node, gateId)),
    outputLimitBytes:
      hook.output_limit_bytes ?? context.hookPolicy.outputLimitBytes,
    timeout: hook.timeout_ms ?? context.hookPolicy.timeoutMs,
  });
  if (result.exitCode === 0) {
    return null;
  }
  return {
    evidence: result.evidence,
    gate: hookId,
    nodeId: node?.id,
    reason: `hook '${hookId}' failed`,
  };
}

function hookPolicyFailure(
  hookId: string,
  node: PlannedWorkflowNode | undefined,
  reason: string
): RuntimeFailure {
  return {
    evidence: [reason],
    gate: hookId,
    nodeId: node?.id,
    reason: `hook '${hookId}' failed`,
  };
}

function hookEnv(
  hook: HookSpec,
  context: RuntimeContext
): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = new Set([
    ...context.hookPolicy.envPassthrough,
    ...(hook.env?.passthrough ?? []),
  ]);
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return {
    ...env,
    ...context.hookPolicy.env,
    ...(hook.env?.set ?? {}),
  };
}

function hookPayload(
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Record<string, unknown> {
  return {
    event: {
      gateId,
      nodeId: node?.id,
      workflowId: context.workflowId,
    },
    failure,
    task: context.task,
    taskContext: context.taskContext,
  };
}

function renderTemplate(
  value: string,
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): string {
  return value
    .replaceAll("{{workflow.id}}", context.workflowId)
    .replaceAll("{{node.id}}", node?.id ?? "")
    .replaceAll("{{gate.id}}", gateId ?? failure?.gate ?? "")
    .replaceAll("{{task}}", context.task)
    .replaceAll("{{reason}}", failure?.reason ?? "");
}

export function formatConfigError(err: PipelineConfigError): string {
  return [
    err.message,
    ...err.issues.map((issue) =>
      issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
    ),
  ].join("\n");
}
