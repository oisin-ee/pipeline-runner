import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Ajv, { type AnySchema, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { execa } from "execa";
import micromatch from "micromatch";
import pLimit from "p-limit";
import simpleGit from "simple-git";
import { createActor, waitFor } from "xstate";
import {
  loadPipelineConfig,
  type PipelineConfig,
  type PipelineConfigError,
} from "./config.js";
import {
  artifactExists,
  runJscpd,
  runSemgrep,
  runTests,
  runTypecheck,
} from "./gates.js";
import { resolveFileReference } from "./path-refs.js";
import {
  type AgentResult,
  createRunnerLaunchPlan,
  type RunnerExecutionOptions,
  type RunnerLaunchPlan,
  runLaunchPlan,
} from "./runner.js";
import { normalizeRunnerOutput } from "./runner-output.js";
import {
  type NodeRetryPolicyContract,
  type RetryReason,
  type RuntimeActorDescriptor,
  type RuntimeObservabilityEmitter,
  type RuntimeObservabilityEvent,
  runtimeActorId,
} from "./runtime-machines/contracts.js";
import { gateEvaluationMachine } from "./runtime-machines/gate-machine.js";
import { hookInvocationMachine } from "./runtime-machines/hook-machine.js";
import {
  type NodeExecutionActor,
  nodeExecutionMachine,
} from "./runtime-machines/node-machine.js";
import {
  type WorkflowSchedulerActor,
  workflowSchedulerMachine,
} from "./runtime-machines/workflow-machine.js";
import {
  createRuntimeInspectionBridge,
  type XStateInspectionEvent,
} from "./runtime-observability-inspection.js";
import { parseJson as parseSafeJson } from "./safe-json.js";
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
// Matchers for the pipeline's own substitution tokens (literal "${runId}" /
// "${nodeId}" text in worktree roots — not JS interpolation). Expressed as
// regexes so the literal "${" sequence never appears in a string the bundler
// could fold into a real template interpolation.
const RUN_ID_TOKEN_RE = /\$\{runId\}/g;
const NODE_ID_TOKEN_RE = /\$\{nodeId\}/g;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_OUTPUT_LIMIT_BYTES = 64 * 1024;
const jsonSchemaValidator = addFormats(
  new Ajv({ allErrors: true, strict: false })
);
const jsonSchemaValidatorCache = new Map<
  string,
  {
    source: string;
    validate: ReturnType<typeof jsonSchemaValidator.compile>;
  }
>();

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
  retry?: {
    attempt: number;
    delayMs: number;
    evidence: string[];
    exhausted: boolean;
    gate: string;
    reason: string;
    retryReason: string;
    scheduled: boolean;
  };
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

export type PipelineRuntimeObservabilityLevel = "info" | "warn";

export type PipelineRuntimeEvent = { parentNodeId?: string } & (
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
      actor: RuntimeActorDescriptor;
      level: PipelineRuntimeObservabilityLevel;
      name: RuntimeObservabilityEvent["type"];
      nodeId?: string;
      summary: string;
      type: "runtime.observability";
      workflowId: string;
    }
  | {
      outcome: PipelineRuntimeResult["outcome"];
      type: "workflow.finish";
      workflowId: string;
    }
);

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
  runId?: string;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowId?: string;
  worktreePath?: string;
}

interface RuntimeContext {
  agentInvocations: RunnerLaunchPlan[];
  baseSha?: Promise<string>;
  config: PipelineConfig;
  executor: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  hookPolicy: Required<HookRuntimePolicy>;
  inheritedOutputNodeIds: Set<string>;
  lastOutputByNode: Map<string, string>;
  maxParallelNodes?: number;
  nodeActors: Map<string, NodeExecutionActor>;
  nodeSnapshots: Map<string, ChangedFilesSnapshot>;
  nodeStates: Map<string, NodeExecutionState>;
  observability?: RuntimeObservabilityEmitter;
  plan: WorkflowExecutionPlan;
  preserveSuccessfulWorkflowWorktrees?: boolean;
  reporter?: (event: PipelineRuntimeEvent) => void;
  runId?: string;
  signal?: AbortSignal;
  task: string;
  taskContext?: PipelineTaskContext;
  workflowActor?: WorkflowSchedulerActor;
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
  fingerprints: Map<string, string>;
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
  retry?: NodeAttemptRetry;
}

interface NodeAttemptRetry {
  attempt: number;
  evidence: string[];
  gate: string;
  reason: string;
  retryReason: RetryReason;
}

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
      batches: context.plan.parallelBatches.map((batch) =>
        batch.map((node) => node.id)
      ),
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
      nodeIds: context.plan.topologicalOrder.map((node) => node.id),
      runNode: (nodeId) => executePlannedNode(nodeId, context),
      runWorkflowHook: (event, failure) =>
        dispatchHooks(context, event, failure),
      shouldContinueAfterNodeResult: (result) =>
        shouldContinueAfterNodeResult(result, context),
      skipNode: (nodeId, reason) =>
        recordNodeEvent(context, nodeId, {
          at: now(),
          reason,
          type: "SKIPPED",
        }),
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
  const runId =
    options.runId ??
    (planReferencesRunIdTemplate(plan) ? generateRuntimeRunId() : undefined);
  const observability = options.reporter
    ? createPublicRuntimeObservabilityEmitter(options.reporter, workflowId)
    : undefined;
  return {
    agentInvocations: [],
    ...(runId ? { runId } : {}),
    config,
    executor: options.executor ?? runLaunchPlan,
    gates: [],
    hookFailures: [],
    inheritedOutputNodeIds: new Set(),
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
    nodeActors: new Map(),
    ...(observability ? { observability } : {}),
    plan,
    preserveSuccessfulWorkflowWorktrees: false,
    ...(options.reporter ? { reporter: options.reporter } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    task: options.task,
    ...(options.taskContext ? { taskContext: options.taskContext } : {}),
    workflowId,
    worktreePath,
  };
}

function createPublicRuntimeObservabilityEmitter(
  reporter: (event: PipelineRuntimeEvent) => void,
  workflowId: string
): RuntimeObservabilityEmitter {
  return (event) => {
    reporter(runtimeObservabilityEventToPipelineEvent(event, workflowId));
  };
}

function runtimeObservabilityEventToPipelineEvent(
  event: RuntimeObservabilityEvent,
  workflowId: string
): PipelineRuntimeEvent {
  const nodeId = runtimeObservabilityNodeId(event);
  return {
    actor: event.actor,
    level: runtimeObservabilityLevel(event),
    name: event.type,
    ...(nodeId ? { nodeId } : {}),
    summary: runtimeObservabilitySummary(event),
    type: "runtime.observability",
    workflowId,
  };
}

function runtimeObservabilityLevel(
  event: RuntimeObservabilityEvent
): PipelineRuntimeObservabilityLevel {
  switch (event.type) {
    case "runtime.gate.cancelled":
    case "runtime.gate.failed":
    case "runtime.hook.failed":
    case "runtime.hook.timedOut":
    case "runtime.retry.exhausted":
      return "warn";
    default:
      return "info";
  }
}

function runtimeObservabilityNodeId(
  event: RuntimeObservabilityEvent
): string | undefined {
  switch (event.type) {
    case "runtime.gate.cancelled":
    case "runtime.gate.failed":
    case "runtime.gate.finished":
    case "runtime.gate.started":
    case "runtime.hook.failed":
    case "runtime.hook.finished":
    case "runtime.hook.skipped":
    case "runtime.hook.started":
    case "runtime.hook.timedOut":
    case "runtime.node.finished":
    case "runtime.node.started":
    case "runtime.retry.exhausted":
    case "runtime.retry.scheduled":
      return event.nodeId;
    default:
      return;
  }
}

function runtimeObservabilitySummary(event: RuntimeObservabilityEvent): string {
  switch (event.type) {
    case "runtime.actor.event":
      return `${event.actor.kind} actor ${event.actor.id} received ${event.eventType}`;
    case "runtime.actor.snapshot":
      return `${event.actor.kind} actor ${event.actor.id} snapshot recorded`;
    case "runtime.gate.cancelled":
      return `gate ${event.gateId} cancelled for node ${event.nodeId}: ${event.reason}`;
    case "runtime.gate.failed":
      return `gate ${event.gateId} failed for node ${event.nodeId}: ${event.reason}`;
    case "runtime.gate.finished":
      return `gate ${event.gateId} ${event.passed ? "passed" : "failed"} for node ${event.nodeId}${event.reason ? `: ${event.reason}` : ""}`;
    case "runtime.gate.started":
      return `gate ${event.gateId} started for node ${event.nodeId}`;
    case "runtime.hook.failed":
      return `hook ${event.hookId} failed${event.nodeId ? ` for node ${event.nodeId}` : ""}: ${event.reason}`;
    case "runtime.hook.finished":
      return `hook ${event.hookId} ${event.passed ? "passed" : "failed"}${event.nodeId ? ` for node ${event.nodeId}` : ""}${event.reason ? `: ${event.reason}` : ""}`;
    case "runtime.hook.skipped":
      return `hook ${event.hookId} skipped${event.nodeId ? ` for node ${event.nodeId}` : ""}: ${event.reason}`;
    case "runtime.hook.started":
      return `hook ${event.hookId} started${event.nodeId ? ` for node ${event.nodeId}` : ""}`;
    case "runtime.hook.timedOut":
      return `hook ${event.hookId} timed out${event.nodeId ? ` for node ${event.nodeId}` : ""}: ${event.reason}`;
    case "runtime.node.finished":
      return `node ${event.nodeId} finished with status ${event.status}`;
    case "runtime.node.started":
      return `node ${event.nodeId} started`;
    case "runtime.retry.exhausted":
      return `node ${event.nodeId} retry exhausted after attempt ${event.attempt} (${event.reason})`;
    case "runtime.retry.scheduled":
      return `node ${event.nodeId} retry scheduled for attempt ${event.attempt} (${event.reason})`;
    case "runtime.state.enter":
      return `${event.actor.kind} actor ${event.actor.id} entered ${event.state}`;
    case "runtime.state.exit":
      return `${event.actor.kind} actor ${event.actor.id} exited ${event.state}`;
    default:
      return assertNeverRuntimeObservabilityEvent(event);
  }
}

function assertNeverRuntimeObservabilityEvent(event: never): never {
  throw new Error(`Unhandled runtime observability event: ${String(event)}`);
}

function runtimeInspection(
  context: RuntimeContext
): ((event: XStateInspectionEvent) => void) | undefined {
  return context.observability
    ? createRuntimeInspectionBridge({
        emit: context.observability,
      })
    : undefined;
}

function runtimeSystemId(context: RuntimeContext): string {
  return runtimeActorId("pipeline", {
    runId: context.runId,
    workflowId: context.workflowId,
  });
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

async function pinWorkflowBaseSha(context: RuntimeContext): Promise<void> {
  if (planContainsWorktreeBackedWorkflowNode(context.plan)) {
    await workflowBaseSha(context);
  }
}

function planContainsWorktreeBackedWorkflowNode(
  plan: WorkflowExecutionPlan
): boolean {
  return nodesContainWorktreeBackedWorkflowNode(plan.topologicalOrder);
}

function nodesContainWorktreeBackedWorkflowNode(
  nodes: PlannedWorkflowNode[]
): boolean {
  return nodes.some(
    (node) =>
      (node.kind === "workflow" && Boolean(node.worktreeRoot)) ||
      nodesContainWorktreeBackedWorkflowNode(node.children ?? [])
  );
}

function planReferencesRunIdTemplate(plan: WorkflowExecutionPlan): boolean {
  return nodesReferenceRunIdTemplate(plan.topologicalOrder);
}

function nodesReferenceRunIdTemplate(nodes: PlannedWorkflowNode[]): boolean {
  return nodes.some(
    (node) =>
      (node.worktreeRoot?.search(RUN_ID_TOKEN_RE) ?? -1) !== -1 ||
      nodesReferenceRunIdTemplate(node.children ?? [])
  );
}

function generateRuntimeRunId(): string {
  return `run-${randomUUID()}`;
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

function executePlannedNode(
  nodeId: string,
  context: RuntimeContext
): Promise<RuntimeNodeResult> {
  const node = context.plan.graph.node(nodeId);
  if (!node) {
    throw new Error(`workflow scheduler referenced unknown node '${nodeId}'`);
  }
  return executeNode(node, context);
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
  if ("schedule" in entrypoint) {
    throw new Error(
      `Pipeline entrypoint '${entrypointId}' generates schedule '${entrypoint.schedule}'; run an approved schedule artifact instead.`
    );
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

function runtimeNodeActorDescriptor(
  context: RuntimeContext,
  nodeId: string
): RuntimeActorDescriptor {
  return {
    id: runtimeActorId("node", {
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    kind: "node",
    systemId: runtimeSystemId(context),
  };
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
  let retry: NodeAttemptRetry | undefined;

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    try {
      const cycle = await executeNodeAttemptCycle(node, context, attempt, last);
      last = cycle.last;
      if (cycle.result) {
        emitNodeFinish(context, cycle.result);
        return cycle.result;
      }
      retry = retryCandidateForCycle(node, cycle, last, attempt);
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
  const gateResults = await evaluateNodeGates(node, context, last);
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

async function snapshotChangedFiles(
  worktreePath: string
): Promise<ChangedFilesSnapshot> {
  try {
    const status = await simpleGit({ baseDir: worktreePath }).status();
    const files = new Set(
      status.files.map((file) => file.path).filter(Boolean)
    );
    return {
      files,
      fingerprints: new Map(
        [...files].map((file) => [file, fileFingerprint(worktreePath, file)])
      ),
    };
  } catch {
    return { files: new Set(), fingerprints: new Map() };
  }
}

function diffChangedFiles(
  before: ChangedFilesSnapshot,
  after: ChangedFilesSnapshot,
  worktreePath: string
): ChangedFilesSnapshot {
  const candidateFiles = new Set([...before.files, ...after.files]);
  const files = [...candidateFiles].filter(
    (file) =>
      !before.files.has(file) ||
      before.fingerprints.get(file) !==
        (after.fingerprints.get(file) ?? fileFingerprint(worktreePath, file))
  );
  return {
    files: new Set(files),
    fingerprints: new Map(
      files.map((file) => [
        file,
        after.fingerprints.get(file) ?? fileFingerprint(worktreePath, file),
      ])
    ),
  };
}

function fileFingerprint(worktreePath: string, file: string): string {
  const fullPath = join(worktreePath, file);
  if (!existsSync(fullPath)) {
    return "missing";
  }
  return createHash("sha256").update(readFileSync(fullPath)).digest("hex");
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
      return executeParallelNode(node, context);
    case "workflow":
      return executeWorkflowNode(node, context);
    default: {
      const _exhaustive: never = node.kind;
      throw new Error(`Unsupported node kind: ${String(_exhaustive)}`);
    }
  }
}

async function executeParallelNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<NodeAttemptResult> {
  const children = node.children ?? [];
  if (children.length === 0) {
    return {
      evidence: [`parallel node '${node.id}' has no children`],
      exitCode: 1,
      output: "",
    };
  }

  const linkedAbort = createLinkedAbortController(context.signal);
  const childContext = createParallelChildContext(
    context,
    node.id,
    children,
    context.plan.execution.failFast
      ? linkedAbort.controller.signal
      : context.signal
  );
  try {
    const results = context.plan.execution.failFast
      ? await executeFailFastParallelChildren(
          children,
          childContext,
          linkedAbort.controller
        )
      : await executeParallelChildren(children, childContext);
    const failed = results.filter((result) => result.status === "failed");
    return {
      evidence: parallelEvidence(node.id, results, failed),
      exitCode: failed.length > 0 ? 1 : 0,
      output: parallelOutput(children, results),
    };
  } finally {
    linkedAbort.cleanup();
  }
}

function createParallelChildContext(
  context: RuntimeContext,
  parentNodeId: string,
  children: PlannedWorkflowNode[],
  signal: AbortSignal | undefined
): RuntimeContext {
  return {
    ...context,
    inheritedOutputNodeIds: new Set(context.lastOutputByNode.keys()),
    lastOutputByNode: new Map(context.lastOutputByNode),
    nodeSnapshots: new Map(),
    nodeActors: new Map(),
    nodeStates: new Map(
      children.map((child) => [
        child.id,
        {
          attempts: 0,
          evidence: [],
          gates: [],
          id: child.id,
          status: "pending",
        },
      ])
    ),
    plan: {
      ...context.plan,
      parallelBatches: [children],
      topologicalOrder: children,
    },
    preserveSuccessfulWorkflowWorktrees:
      context.preserveSuccessfulWorkflowWorktrees ||
      parallelFeedsDrainMerge(parentNodeId, context),
    reporter: childReporter(context, parentNodeId),
    ...(signal ? { signal } : {}),
  };
}

function parallelFeedsDrainMerge(
  parentNodeId: string,
  context: RuntimeContext
): boolean {
  const parent = context.plan.graph.node(parentNodeId);
  return (
    parent?.dependents.length > 0 &&
    parent.dependents.every((dependentId) =>
      isDrainMergeNode(context.plan.graph.node(dependentId))
    )
  );
}

function createLinkedAbortController(signal?: AbortSignal): {
  cleanup: () => void;
  controller: AbortController;
} {
  const controller = new AbortController();
  if (!signal) {
    return { cleanup: () => undefined, controller };
  }
  if (signal.aborted) {
    controller.abort();
    return { cleanup: () => undefined, controller };
  }
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return {
    cleanup: () => signal.removeEventListener("abort", abort),
    controller,
  };
}

function executeParallelChildren(
  children: PlannedWorkflowNode[],
  context: RuntimeContext
): Promise<RuntimeNodeResult[]> {
  for (const child of children) {
    recordNodeEvent(context, child.id, { at: now(), type: "READY" });
  }
  if (!context.maxParallelNodes) {
    return Promise.all(children.map((child) => executeNode(child, context)));
  }
  const limit = pLimit(context.maxParallelNodes);
  return Promise.all(
    children.map((child) => limit(() => executeNode(child, context)))
  );
}

async function executeFailFastParallelChildren(
  children: PlannedWorkflowNode[],
  context: RuntimeContext,
  abortController: AbortController
): Promise<RuntimeNodeResult[]> {
  for (const child of children) {
    recordNodeEvent(context, child.id, { at: now(), type: "READY" });
  }
  const limit = pLimit({
    concurrency: context.maxParallelNodes ?? children.length,
    rejectOnClear: true,
  });
  const settled = await Promise.allSettled(
    children.map((child) =>
      limit(async () => {
        const result = await executeNode(child, context);
        if (result.status === "failed") {
          abortController.abort();
          limit.clearQueue();
        }
        return result;
      })
    )
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
}

function parallelEvidence(
  nodeId: string,
  results: RuntimeNodeResult[],
  failed: RuntimeNodeResult[]
): string[] {
  if (failed.length === 0) {
    return [
      `parallel node '${nodeId}' completed ${results.length} child nodes`,
    ];
  }
  return [
    `parallel node '${nodeId}' failed with ${failed.length} failed child nodes`,
    ...failed.flatMap((result) => result.evidence),
  ];
}

function parallelOutput(
  children: PlannedWorkflowNode[],
  results: RuntimeNodeResult[]
): string {
  const outputsByNode = new Map(
    results.map((result) => [result.nodeId, result.output])
  );
  return JSON.stringify({
    children: Object.fromEntries(
      children
        .filter((child) => outputsByNode.has(child.id))
        .map((child) => [child.id, outputsByNode.get(child.id)])
    ),
  });
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
    taskContext: context.taskContext,
    workflowId: node.workflow,
    worktreePath: worktree.worktreePath ?? context.worktreePath,
  });
  childContext.baseSha = context.baseSha;
  childContext.lastOutputByNode = workflowChildInheritedOutputs(node, context);
  childContext.inheritedOutputNodeIds = new Set(
    childContext.lastOutputByNode.keys()
  );

  const result = await runPipelineWithContext(childContext);
  context.agentInvocations.push(...result.agentInvocations);
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

interface WorkflowNodeWorktree {
  baseSha: string | null;
  branch: string | null;
  worktreePath: string | null;
}

async function prepareWorkflowNodeWorktree(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<WorkflowNodeWorktree> {
  if (!node.worktreeRoot) {
    return { baseSha: null, branch: null, worktreePath: null };
  }

  const baseSha = await workflowBaseSha(context);
  const branch = `${context.runId ?? generateRuntimeRunId()}/${node.id}`;
  const worktreePath = resolveWorkflowNodeWorktreePath(node, context);
  mkdirSync(dirname(worktreePath), { recursive: true });
  await simpleGit({ baseDir: context.worktreePath }).raw([
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseSha,
  ]);
  ensurePipelineSymlink(context.worktreePath, worktreePath);
  return { baseSha, branch, worktreePath };
}

function workflowBaseSha(context: RuntimeContext): Promise<string> {
  context.baseSha ??= simpleGit({ baseDir: context.worktreePath }).revparse([
    "HEAD",
  ]);
  return context.baseSha;
}

function resolveWorkflowNodeWorktreePath(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): string {
  const rendered = (node.worktreeRoot ?? "")
    .replaceAll(RUN_ID_TOKEN_RE, context.runId ?? generateRuntimeRunId())
    .replaceAll(NODE_ID_TOKEN_RE, node.id);
  return resolve(context.worktreePath, rendered);
}

function ensurePipelineSymlink(
  parentWorktreePath: string,
  childWorktreePath: string
): void {
  if (!existsSync(childWorktreePath)) {
    return;
  }
  const source = join(parentWorktreePath, ".pipeline");
  const target = join(childWorktreePath, ".pipeline");
  if (existsSync(source) && !existsSync(target)) {
    symlinkSync(source, target, "dir");
  }
}

async function removeWorkflowNodeWorktree(worktreePath: string): Promise<void> {
  await simpleGit().raw(["worktree", "remove", "--force", worktreePath]);
}

function childReporter(
  context: RuntimeContext,
  parentNodeId: string
): PipelineRuntimeOptions["reporter"] {
  if (!context.reporter) {
    return;
  }
  return (event) => {
    context.reporter?.(prefixChildRuntimeEvent(parentNodeId, event));
  };
}

function prefixChildRuntimeEvent(
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent {
  const prefixed = { ...event } as Record<string, unknown>;
  prefixed.parentNodeId = parentNodeId;
  if (typeof prefixed.nodeId === "string") {
    prefixed.nodeId = `${parentNodeId}.${prefixed.nodeId}`;
  }
  if (Array.isArray(prefixed.nodeIds)) {
    prefixed.nodeIds = prefixed.nodeIds.map((id) =>
      typeof id === "string" ? `${parentNodeId}.${id}` : id
    );
  }
  if (Array.isArray(prefixed.nodes)) {
    prefixed.nodes = prefixed.nodes.map((child) =>
      isRecord(child) && typeof child.id === "string"
        ? { ...child, id: `${parentNodeId}.${child.id}` }
        : child
    );
  }
  if (Array.isArray(prefixed.edges)) {
    prefixed.edges = prefixed.edges.map((edge) =>
      isRecord(edge)
        ? {
            ...edge,
            source:
              typeof edge.source === "string"
                ? `${parentNodeId}.${edge.source}`
                : edge.source,
            target:
              typeof edge.target === "string"
                ? `${parentNodeId}.${edge.target}`
                : edge.target,
          }
        : edge
    );
  }
  return prefixed as PipelineRuntimeEvent;
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
  return normalizeRunnerOutput(plan, stdout);
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
    ...inheritedOutputSections(node, context),
    "Dependency outputs:",
    ...node.needs.map(
      (need) => `## ${need}\n${context.lastOutputByNode.get(need) ?? ""}`
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function inheritedOutputSections(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): string[] {
  const ownNeeds = new Set(node.needs);
  const inherited = [...context.inheritedOutputNodeIds].filter(
    (id) => !ownNeeds.has(id) && context.lastOutputByNode.has(id)
  );
  if (inherited.length === 0) {
    return [];
  }
  return [
    "Inherited dependency outputs:",
    ...inherited.map(
      (id) => `## ${id}\n${context.lastOutputByNode.get(id) ?? ""}`
    ),
    "",
  ];
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
    return readFileSync(
      resolveFileReference(worktreePath, instructions.path),
      "utf8"
    );
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
      const content = readFileSync(
        resolveFileReference(worktreePath, path),
        "utf8"
      ).trimEnd();
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
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  switch (builtin) {
    case "drain-merge":
      return executeDrainMergeBuiltin(context, node);
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
    case "semgrep": {
      const result = await runSemgrep(context.worktreePath, context.signal);
      return {
        evidence: [result.output],
        exitCode: result.exitCode,
        output: result.output,
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

type DrainMergeStatus = "FAIL" | "PASS";

interface DrainMergeChildOutput {
  baseSha: string | null;
  branch: string | null;
  status: DrainMergeStatus;
  worktreePath: string | null;
}

interface DrainMergeMergeEntry {
  branch: string;
  id: string;
  worktreePath: string;
}

interface DrainMergeSkipEntry {
  id: string;
  reason: "failed" | "no-worktree";
  status: DrainMergeStatus;
}

interface DrainMergeConflictEntry {
  branch: string;
  files: string[];
  id: string;
  worktreePath: string;
}

interface DrainMergeReport {
  baseSha: string | null;
  conflicts: DrainMergeConflictEntry[];
  integrationBranch: string;
  merged: DrainMergeMergeEntry[];
  skipped: DrainMergeSkipEntry[];
}

async function executeDrainMergeBuiltin(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  const upstreamNodeId = node?.needs.at(0) ?? null;
  const integrationBranch = `runs/integration/${
    context.runId ?? generateRuntimeRunId()
  }`;
  const report: DrainMergeReport = {
    baseSha: null,
    conflicts: [],
    integrationBranch,
    merged: [],
    skipped: [],
  };

  const children = drainMergeChildren(context, upstreamNodeId);
  const mergeable = drainMergeMergeableChildren(children, report);
  if (mergeable.length === 0) {
    return drainMergeResult(report);
  }

  report.baseSha = mergeable[0].output.baseSha;
  const divergent = mergeable.find(
    (child) => child.output.baseSha !== report.baseSha
  );
  if (divergent) {
    return drainMergeResult(report, {
      evidence: [
        `drain-merge child '${divergent.nodeId}' baseSha ${divergent.output.baseSha} diverges from ${report.baseSha}`,
      ],
      failed: true,
    });
  }

  const git = simpleGit({ baseDir: context.worktreePath });
  try {
    await checkoutDrainMergeIntegrationBranch(
      git,
      integrationBranch,
      report.baseSha
    );
  } catch (error) {
    return drainMergeResult(report, {
      evidence: [
        `drain-merge setup-error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      failed: true,
    });
  }

  for (const child of mergeable) {
    try {
      await git.raw([
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        "drain-merge: merge",
        child.output.branch,
      ]);
      report.merged.push({
        branch: child.output.branch,
        id: child.nodeId,
        worktreePath: child.output.worktreePath,
      });
    } catch {
      const files = await drainMergeConflictFiles(git);
      report.conflicts.push({
        branch: child.output.branch,
        files,
        id: child.nodeId,
        worktreePath: child.output.worktreePath,
      });
      await abortDrainMerge(git);
    }
  }

  return drainMergeResult(report);
}

function drainMergeChildren(
  context: RuntimeContext,
  upstreamNodeId: string | null
): Array<{ nodeId: string; output: DrainMergeChildOutput }> {
  if (!upstreamNodeId) {
    return [];
  }
  const upstream = context.plan.graph.node(upstreamNodeId);
  const output = parseJsonObject(context.lastOutputByNode.get(upstreamNodeId));
  const childrenOutput = parseJsonObject(output.children);
  return (upstream?.children ?? []).flatMap((child) => {
    const childOutput = parseDrainMergeChildOutput(childrenOutput[child.id]);
    return childOutput ? [{ nodeId: child.id, output: childOutput }] : [];
  });
}

function drainMergeMergeableChildren(
  children: Array<{ nodeId: string; output: DrainMergeChildOutput }>,
  report: DrainMergeReport
): Array<{
  nodeId: string;
  output: DrainMergeChildOutput & {
    baseSha: string;
    branch: string;
    worktreePath: string;
  };
}> {
  return children.flatMap((child) => {
    if (child.output.status !== "PASS") {
      report.skipped.push({
        id: child.nodeId,
        reason: "failed",
        status: child.output.status,
      });
      return [];
    }
    if (
      !(
        child.output.baseSha &&
        child.output.branch &&
        child.output.worktreePath
      )
    ) {
      report.skipped.push({
        id: child.nodeId,
        reason: "no-worktree",
        status: child.output.status,
      });
      return [];
    }
    return [
      {
        nodeId: child.nodeId,
        output: {
          baseSha: child.output.baseSha,
          branch: child.output.branch,
          status: child.output.status,
          worktreePath: child.output.worktreePath,
        },
      },
    ];
  });
}

async function checkoutDrainMergeIntegrationBranch(
  git: ReturnType<typeof simpleGit>,
  integrationBranch: string,
  baseSha: string
): Promise<void> {
  try {
    await git.raw(["rev-parse", "--verify", integrationBranch]);
    await git.raw(["checkout", integrationBranch]);
  } catch {
    await git.raw(["checkout", "-b", integrationBranch, baseSha]);
  }
}

async function drainMergeConflictFiles(
  git: ReturnType<typeof simpleGit>
): Promise<string[]> {
  try {
    const output = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
    return output.split(LINE_RE).filter(Boolean);
  } catch {
    return [];
  }
}

async function abortDrainMerge(
  git: ReturnType<typeof simpleGit>
): Promise<void> {
  try {
    await git.raw(["merge", "--abort"]);
  } catch {
    // The merge failure is already captured in the report; abort errors should
    // not prevent later siblings from being attempted.
  }
}

function parseDrainMergeChildOutput(
  value: unknown
): DrainMergeChildOutput | null {
  const output = parseJsonObject(value);
  if (Object.keys(output).length === 0) {
    return null;
  }
  return {
    baseSha: typeof output.baseSha === "string" ? output.baseSha : null,
    branch: typeof output.branch === "string" ? output.branch : null,
    status: output.status === "PASS" ? "PASS" : "FAIL",
    worktreePath:
      typeof output.worktreePath === "string" ? output.worktreePath : null,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = parseSafeJson(value, "runtime JSON object");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function drainMergeResult(
  report: DrainMergeReport,
  options: { evidence?: string[]; failed?: boolean } = {}
): NodeAttemptResult {
  const hasFailure = report.conflicts.length > 0 || options.failed === true;
  return {
    evidence: [
      ...(options.evidence ?? []),
      hasFailure
        ? `drain-merge completed with ${report.conflicts.length} conflicts`
        : `drain-merge merged ${report.merged.length} branches`,
    ],
    exitCode: hasFailure ? 1 : 0,
    output: JSON.stringify(report),
  };
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
    const result = await runGateEvaluationActor(
      gate,
      gateId,
      node.id,
      context,
      attempt
    );
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

async function runGateEvaluationActor(
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): Promise<RuntimeGateResult> {
  const actor = createActor(gateEvaluationMachine, {
    id: runtimeActorId("gate", {
      gateId,
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    input: {
      actor: {
        id: runtimeActorId("gate", {
          gateId,
          nodeId,
          runId: context.runId,
          workflowId: context.workflowId,
        }),
        kind: "gate",
        systemId: runtimeSystemId(context),
      },
      emit: context.observability,
      evaluate: () => evaluateGate(gate, nodeId, context, attempt),
      gateId,
      kind: gate.kind,
      nodeId,
    },
    ...(runtimeInspection(context)
      ? { inspect: runtimeInspection(context) }
      : {}),
  });
  actor.start();
  actor.send({ type: "START" });
  const snapshot = await waitFor(actor, (state) => state.status === "done");
  actor.stop();
  const result = snapshot.context.result;
  if (!result) {
    throw new Error(`gate '${gateId}' finished without a result`);
  }
  return result;
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
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, node.id),
    nodeId: node.id,
    timestamp: now(),
    type: "runtime.node.started",
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
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, result.nodeId),
    nodeId: result.nodeId,
    status: result.status,
    timestamp: now(),
    type: "runtime.node.finished",
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
          .map((line) => parseSafeJson(line, "runtime JSONL line")),
      };
    }
    return { output: parseSafeJson(output, "runtime JSON output") };
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
    return { value: parseSafeJson(source.source ?? "", "gate JSON") };
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
    const schemaSource = readFileSync(join(worktreePath, schemaPath), "utf8");
    const value = parseSafeJson(source, "JSON schema gate value");
    const validate = compiledJsonSchemaValidator(schemaPath, schemaSource);
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

function compiledJsonSchemaValidator(
  schemaPath: string,
  schemaSource: string
): ReturnType<typeof jsonSchemaValidator.compile> {
  const cached = jsonSchemaValidatorCache.get(schemaPath);
  if (cached?.source === schemaSource) {
    return cached.validate;
  }
  const schema = parseSafeJson(schemaSource, `JSON schema ${schemaPath}`);
  if (!isJsonSchema(schema)) {
    throw new Error(`JSON schema ${schemaPath} must be an object or boolean`);
  }
  const validate = jsonSchemaValidator.compile(schema);
  jsonSchemaValidatorCache.set(schemaPath, { source: schemaSource, validate });
  return validate;
}

function isJsonSchema(value: unknown): value is AnySchema {
  return typeof value === "boolean" || isRecord(value);
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
    const result = await runHookInvocationActor(
      context,
      hookId,
      hook,
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

async function runHookInvocationActor(
  context: RuntimeContext,
  hookId: string,
  hook: HookSpec,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeFailure | null> {
  const actor = createActor(hookInvocationMachine, {
    id: runtimeActorId("hook", {
      hookId,
      nodeId: node?.id,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    input: {
      actor: {
        id: runtimeActorId("hook", {
          hookId,
          nodeId: node?.id,
          runId: context.runId,
          workflowId: context.workflowId,
        }),
        kind: "hook",
        systemId: runtimeSystemId(context),
      },
      emit: context.observability,
      execute: async () => {
        const hookFailure = await executeHook(
          hook,
          hookId,
          context,
          failure,
          node,
          gateId
        );
        return hookFailure
          ? {
              failure: hookFailure,
              reason: hookFailure.reason,
              status: hookFailure.evidence.some((item) =>
                item.toLowerCase().includes("timed out")
              )
                ? ("timedOut" as const)
                : ("failed" as const),
            }
          : { status: "passed" as const };
      },
      hookId,
      nodeId: node?.id,
      required: hook.required === true,
    },
    ...(runtimeInspection(context)
      ? { inspect: runtimeInspection(context) }
      : {}),
  });
  actor.start();
  actor.send({ type: "START" });
  const snapshot = await waitFor(actor, (state) => state.status === "done");
  actor.stop();
  return snapshot.context.result?.failure ?? null;
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
