import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ErrorObject } from "ajv";
import { execa } from "execa";
import micromatch from "micromatch";
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

export interface PipelineRuntimeResult {
  agentInvocations: RunnerLaunchPlan[];
  failureDetails: RuntimeFailure[];
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  nodes: RuntimeNodeResult[];
  outcome: "CANCELLED" | "FAIL" | "PASS";
  plan: WorkflowExecutionPlan;
}

export type PipelineRuntimeEvent =
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
  nodeSnapshots: Map<string, ChangedFilesSnapshot>;
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
    nodeSnapshots: new Map(),
    plan,
    ...(options.reporter ? { reporter: options.reporter } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    task: options.task,
    ...(options.taskContext ? { taskContext: options.taskContext } : {}),
    workflowId,
    worktreePath,
  };
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
    const results = await Promise.all(
      batch.map((node) => executeNode(node, context))
    );
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
    nodes,
    outcome: "CANCELLED",
    plan: context.plan,
  };
}

function cancelledFailure(): RuntimeFailure {
  return {
    evidence: ["pipeline cancelled by AbortSignal"],
    gate: "cancelled",
    reason: "pipeline cancelled",
  };
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

async function executeNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<RuntimeNodeResult> {
  const maxAttempts = node.retries?.max_attempts ?? 1;
  let last: NodeAttemptResult = {
    evidence: [],
    exitCode: 1,
    output: "",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const cycle = await executeNodeAttemptCycle(
      node,
      context,
      attempt,
      maxAttempts,
      last
    );
    last = cycle.last;
    if (cycle.result) {
      emitNodeFinish(context, cycle.result);
      return cycle.result;
    }
  }

  const result = nodeFailure(node.id, maxAttempts, last.evidence, last.output);
  emitNodeFinish(context, result);
  return result;
}

async function executeNodeAttemptCycle(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  maxAttempts: number,
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
  const startHook = await dispatchHooks(context, "node.start", undefined, node);
  if (startHook) {
    return {
      last: previous,
      result: nodeFailure(
        node.id,
        attempt,
        startHook.evidence,
        previous.output
      ),
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
    snapshotChangedFiles(context.worktreePath)
  );
  const last = await executeNodeAttempt(node, context, attempt);
  const afterSnapshot = snapshotChangedFiles(context.worktreePath);
  const beforeSnapshot = context.nodeSnapshots.get(node.id);
  if (beforeSnapshot) {
    context.nodeSnapshots.set(
      node.id,
      diffChangedFiles(beforeSnapshot, afterSnapshot)
    );
  }
  context.lastOutputByNode.set(node.id, last.output);
  const cancelledAfterAttempt = cancelledNodeResult(
    context,
    node.id,
    attempt,
    last
  );
  if (cancelledAfterAttempt) {
    return { last, result: cancelledAfterAttempt };
  }

  const gateResults = await evaluateNodeGates(node, context, last);
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
    return { last, result };
  }

  const evidence = failedGate
    ? [...last.evidence, ...failedGate.evidence]
    : last.evidence.concat(`node exited with code ${last.exitCode}`);
  if (attempt === maxAttempts) {
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
    return { last, result };
  }

  return { last };
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
  return {
    attempts: attempt,
    evidence: [...last.evidence, ...cancelledFailure().evidence],
    exitCode: last.exitCode,
    nodeId,
    output: last.output,
    status: last.exitCode === 0 ? "passed" : "failed",
  };
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

function snapshotChangedFiles(worktreePath: string): ChangedFilesSnapshot {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return {
      files: new Set(
        output
          .split(LINE_RE)
          .map((line) => line.slice(3).trim())
          .map((line) => line.replace(/^"|"$/g, ""))
          .filter(Boolean)
      ),
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
      return executeCommand(node.command ?? [], context);
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
    default: {
      const _exhaustive: never = gate.kind;
      throw new Error(`Unsupported gate kind: ${String(_exhaustive)}`);
    }
  }
}

async function evaluateCommandGate(
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
  gate: GateSpec,
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
