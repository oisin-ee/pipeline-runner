import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import {
  loadPipelineConfig,
  type PipelineConfig,
  type PipelineConfigError,
} from "./mastra/config.js";
import {
  artifactExists,
  runJscpd,
  runTests,
  runTypecheck,
} from "./mastra/gates.js";
import {
  type AgentResult,
  createRunnerLaunchPlan,
  type RunnerLaunchPlan,
  runLaunchPlan,
} from "./mastra/runner.js";
import {
  compileWorkflowPlan,
  type PlannedWorkflowNode,
  type WorkflowExecutionPlan,
} from "./workflow-planner.js";

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];
type GateSpec = NonNullable<WorkflowNode["gates"]>[number];
type HookSpec = PipelineConfig["hooks"][string];
const LINE_RE = /\r?\n/;

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
  outcome: "FAIL" | "PASS";
  plan: WorkflowExecutionPlan;
}

export interface PipelineRuntimeOptions {
  config?: PipelineConfig;
  executor?: (plan: RunnerLaunchPlan) => AgentResult | Promise<AgentResult>;
  task: string;
  workflowId?: string;
  worktreePath?: string;
}

interface RuntimeContext {
  agentInvocations: RunnerLaunchPlan[];
  config: PipelineConfig;
  executor: (plan: RunnerLaunchPlan) => AgentResult | Promise<AgentResult>;
  gates: RuntimeGateResult[];
  hookFailures: RuntimeFailure[];
  lastOutputByNode: Map<string, string>;
  plan: WorkflowExecutionPlan;
  task: string;
  workflowId: string;
  worktreePath: string;
}

interface NodeAttemptResult {
  evidence: string[];
  exitCode: number;
  output: string;
}

export async function runPipelineFromConfig(
  options: PipelineRuntimeOptions
): Promise<PipelineRuntimeResult> {
  const worktreePath = options.worktreePath ?? process.cwd();
  const config = options.config ?? loadPipelineConfig(worktreePath);
  const plan = compileWorkflowPlan(config, options.workflowId);
  const workflowId = plan.workflowId;
  const context: RuntimeContext = {
    agentInvocations: [],
    config,
    executor: options.executor ?? runLaunchPlan,
    gates: [],
    hookFailures: [],
    lastOutputByNode: new Map(),
    plan,
    task: options.task,
    workflowId,
    worktreePath,
  };
  const nodes: RuntimeNodeResult[] = [];

  const startHook = await dispatchHooks(context, "workflow.start");
  if (startHook) {
    return failedRuntimeResult(context, nodes, startHook);
  }

  for (const batch of plan.parallelBatches) {
    const results = await Promise.all(
      batch.map((node) => executeNode(node, context))
    );
    nodes.push(...results);
    const failed = results.find((result) => result.status === "failed");
    if (failed) {
      const failure = {
        evidence: failed.evidence,
        gate: failed.nodeId,
        nodeId: failed.nodeId,
        reason: `node '${failed.nodeId}' failed`,
      };
      await dispatchHooks(context, "workflow.failure", failure);
      await dispatchHooks(context, "workflow.complete", failure);
      return failedRuntimeResult(context, nodes, failure);
    }
  }

  const successHook = await dispatchHooks(context, "workflow.success");
  const completeHook = await dispatchHooks(context, "workflow.complete");
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
    plan,
  };
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
    const startHook = await dispatchHooks(
      context,
      "node.start",
      undefined,
      node
    );
    if (startHook) {
      return nodeFailure(node.id, attempt, startHook.evidence, last.output);
    }

    last = await executeNodeAttempt(node, context);
    context.lastOutputByNode.set(node.id, last.output);

    const gateResults = await evaluateNodeGates(node, context, last);
    const failedGate = gateResults.find((gate) => !gate.passed);
    if (!failedGate && last.exitCode === 0) {
      const successHook = await dispatchHooks(
        context,
        "node.success",
        undefined,
        node
      );
      if (successHook) {
        return nodeFailure(node.id, attempt, successHook.evidence, last.output);
      }
      return {
        attempts: attempt,
        evidence: last.evidence,
        exitCode: 0,
        nodeId: node.id,
        output: last.output,
        status: "passed",
      };
    }

    const evidence =
      failedGate?.evidence ??
      last.evidence.concat(`node exited with code ${last.exitCode}`);
    if (attempt === maxAttempts) {
      await dispatchHooks(
        context,
        "node.error",
        {
          evidence,
          gate: failedGate?.gateId ?? node.id,
          nodeId: node.id,
          reason:
            failedGate?.reason ?? `node exited with code ${last.exitCode}`,
        },
        node
      );
      return nodeFailure(node.id, attempt, evidence, last.output);
    }
  }

  return nodeFailure(node.id, maxAttempts, last.evidence, last.output);
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
  context: RuntimeContext
): NodeAttemptResult | Promise<NodeAttemptResult> {
  switch (node.kind) {
    case "agent":
      return executeAgentNode(node, context);
    case "command":
      return executeCommand(node.command ?? [], context.worktreePath);
    case "builtin":
      return executeBuiltin(node.builtin ?? "", context.worktreePath);
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
  context: RuntimeContext
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
  const result = await context.executor(plan);
  const normalized = normalizeAgentOutput(plan, result.stdout);
  return {
    evidence: [
      `agent boundary node=${node.id} profile=${node.profile} runner=${plan.runnerId} strategy=${plan.strategy}`,
      ...normalized.evidence,
      ...(result.stderr ? [`stderr: ${result.stderr}`] : []),
      ...(result.timedOut ? ["agent timed out"] : []),
    ],
    exitCode: result.exitCode,
    output: normalized.output,
  };
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
      return [
        `## ${id}`,
        `command: ${server?.command ?? ""}`,
        `args: ${(server?.args ?? []).join(" ") || "none"}`,
        `env: ${Object.keys(server?.env ?? {}).join(", ") || "none"}`,
      ].join("\n");
    }),
  ].join("\n");
}

async function executeCommand(
  command: string[],
  worktreePath: string,
  timeout?: number
): Promise<NodeAttemptResult> {
  if (command.length === 0) {
    return { evidence: ["empty command"], exitCode: 1, output: "" };
  }
  try {
    const result = await execa(command[0] as string, command.slice(1), {
      cwd: worktreePath,
      timeout,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      evidence: [
        `command exited ${result.exitCode ?? 0}: ${command.join(" ")}`,
      ],
      exitCode: result.exitCode ?? 0,
      output,
    };
  } catch (err) {
    const e = err as {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return {
      evidence: [
        `command exited ${e.exitCode ?? 1}: ${command.join(" ")}`,
        ...(e.timedOut ? ["command timed out"] : []),
        output,
      ].filter(Boolean),
      exitCode: e.exitCode ?? 1,
      output,
    };
  }
}

async function executeBuiltin(
  builtin: string,
  worktreePath: string
): Promise<NodeAttemptResult> {
  switch (builtin) {
    case "test": {
      const result = await runTests(worktreePath);
      return {
        evidence: [result.output, ...result.failingTests],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "typecheck": {
      const result = await runTypecheck(worktreePath);
      return {
        evidence: [result.output],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "duplication": {
      const result = await runJscpd(worktreePath);
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
  const explicitGates = node.gates ?? [];
  const artifactGates = (node.artifacts ?? []).map(
    (artifact): GateSpec => ({
      id: `artifact:${artifact.path}`,
      kind: "artifact",
      path: artifact.path,
      required: artifact.required,
    })
  );
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  const schemaGate: GateSpec[] =
    profile?.output?.format === "json_schema" && profile.output.schema_path
      ? [
          {
            id: `output:${node.id}`,
            kind: "json_schema",
            schema_path: profile.output.schema_path,
            target: "stdout",
          },
        ]
      : [];
  const results: RuntimeGateResult[] = [];
  for (const gate of [...explicitGates, ...artifactGates, ...schemaGate]) {
    const result = await evaluateGate(gate, node.id, context, attempt);
    context.gates.push(result);
    results.push(result);
    if (!result.passed) {
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
      if (gate.required !== false) {
        break;
      }
    }
  }
  return results;
}

async function evaluateGate(
  gate: GateSpec,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): Promise<RuntimeGateResult> {
  const gateId = gate.id ?? `${gate.kind}:${nodeId}`;
  if (gate.kind === "command") {
    const result = await executeCommand(
      gate.command ?? [],
      context.worktreePath,
      gate.timeout_ms
    );
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
  if (gate.kind === "artifact") {
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
  if (gate.kind === "builtin") {
    const result = await executeBuiltin(
      gate.builtin ?? "",
      context.worktreePath
    );
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
  return evaluateJsonSchemaGate(gate, gateId, nodeId, context, attempt);
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
  try {
    const schema = JSON.parse(
      readFileSync(join(context.worktreePath, schemaPath), "utf8")
    );
    const value = JSON.parse(source);
    const errors = validateJsonSchema(value, schema);
    return {
      evidence:
        errors.length === 0
          ? [`JSON schema passed: ${schemaPath}`]
          : errors.map((error) => `schema: ${error}`),
      gateId,
      kind: gate.kind,
      nodeId,
      passed: errors.length === 0,
      reason: errors.length === 0 ? undefined : "JSON schema validation failed",
    };
  } catch (err) {
    return {
      evidence: [err instanceof Error ? err.message : String(err)],
      gateId,
      kind: gate.kind,
      nodeId,
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

function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  validateSchemaAt(value, schema, "$", errors);
  return errors;
}

function validateSchemaAt(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
): void {
  const type = schema.type;
  if (!validateTypeAndEnum(value, schema, path, errors)) {
    return;
  }
  if (type === "object" && isRecord(value)) {
    validateObjectSchema(value, schema, path, errors);
  }
  if (type === "array" && Array.isArray(value)) {
    validateArraySchema(value, schema, path, errors);
  }
}

function validateTypeAndEnum(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
): boolean {
  const type = schema.type;
  if (typeof type === "string" && !matchesJsonType(value, type)) {
    errors.push(`${path} expected ${type}`);
    return false;
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(value)) {
    errors.push(`${path} expected one of ${enumValues.join(", ")}`);
  }
  return true;
}

function validateObjectSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in value)) {
      errors.push(`${path}.${key} is required`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in value && isRecord(childSchema)) {
      validateSchemaAt(value[key], childSchema, `${path}.${key}`, errors);
    }
  }
}

function validateArraySchema(
  value: unknown[],
  schema: Record<string, unknown>,
  path: string,
  errors: string[]
): void {
  if (!isRecord(schema.items)) {
    return;
  }
  for (const [index, item] of value.entries()) {
    validateSchemaAt(item, schema.items, `${path}[${index}]`, errors);
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
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
  const workflow = context.config.workflows[context.workflowId];
  const hookIds = [...(workflow?.hooks ?? []), ...(node?.hooks ?? [])];
  for (const hookId of hookIds) {
    const hook = context.config.hooks[hookId];
    if (!hook || hook.event !== event) {
      continue;
    }
    const result = await executeHook(
      hook,
      hookId,
      context,
      failure,
      node,
      gateId
    );
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

async function executeHook(
  hook: HookSpec,
  hookId: string,
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeFailure | null> {
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
  const rendered = (hook.command ?? []).map((part) =>
    renderTemplate(part, context, failure, node, gateId)
  );
  const result = await executeCommand(
    rendered,
    context.worktreePath,
    hook.timeout_ms
  );
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
