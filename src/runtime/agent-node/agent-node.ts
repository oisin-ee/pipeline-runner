import { readFileSync } from "node:fs";
import type { PipelineConfig } from "../../config";
import { buildRepoMapContext } from "../../context/repo-map";
import { gatewayServerForProfile } from "../../mcp/gateway";
import { type ModelSelection, selectNodeModel } from "../../model-resolver";
import { resolvePackageAssetPath } from "../../package-assets";
import { resolveFileReference } from "../../path-refs";
import type { PlannedWorkflowNode } from "../../planning/compile";
import {
  type AgentResult,
  createRunnerLaunchPlan,
  type RunnerLaunchPlan,
} from "../../runner";
import {
  normalizeRunnerOutput,
  runnerTextCandidates,
} from "../../runner-output";
import { estimateTokens } from "../../token-estimator";
import type {
  JsonSchemaValidationResult,
  NodeAttemptResult,
  OutputRepairContext,
  PipelineTaskContext,
  RuntimeContext,
} from "../contracts";
import { emit, emitAgentFinish, emitAgentStart } from "../events";
import {
  handoffFinalizerPrompt,
  type NodeHandoff,
  parseHandoff,
  renderHandoff,
  synthesizeMinimalHandoff,
} from "../handoff";
import {
  normalizeJsonSource,
  readJsonSchemaSource,
  validateJsonSchemaSource,
} from "../json-validation";

export async function executeAgentNode(
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
  const prompt = await renderAgentPrompt(node, context);
  const decision = decideNodeModel(prompt, node, context.config.token_budget);
  if (decision.overBudget) {
    return {
      evidence: [
        `agent boundary node=${node.id} profile=${node.profile}`,
        `over token budget: ${decision.selection.reason}`,
        ...(decision.selection.skipped.length
          ? [
              `model fallbacks skipped: ${decision.selection.skipped.join(", ")}`,
            ]
          : []),
      ],
      exitCode: 1,
      output: "",
    };
  }
  const modelSelection = decision.selection;
  const plan = createRunnerLaunchPlan(context.config, {
    model: modelSelection.model,
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
  const result = await context.executor(plan, {
    onOutput: (event) => {
      if (event.stream !== "stdout") {
        return;
      }
      emit(context, {
        attempt,
        format: "text",
        nodeId: node.id,
        output: event.chunk,
        ...(node.profile ? { profile: node.profile } : {}),
        type: "node.output.recorded",
      });
    },
    signal: context.signal,
  });
  emitAgentFinish(context, plan, attempt, result);
  if (result.sessionId) {
    context.nodeStateStore.recordSessionId(node.id, result.sessionId);
  }
  const normalized = normalizeAgentOutput(plan, result.stdout);
  const finalized = await finalizeAgentOutput({
    context,
    node,
    normalized,
    plan,
    result,
    attempt,
  });
  const handoff = await maybeDeriveHandoff(
    context,
    node,
    finalized.output,
    attempt
  );
  const attemptResult: NodeAttemptResult = {
    evidence: [
      `agent boundary node=${node.id} profile=${node.profile} runner=${plan.runnerId}`,
      `estimated context tokens: ${decision.estimatedTokens}`,
      `model selection: ${modelSelection.model ?? "profile/default"} (${modelSelection.reason})`,
      ...(modelSelection.skipped.length
        ? [`model fallbacks skipped: ${modelSelection.skipped.join(", ")}`]
        : []),
      ...finalized.evidence,
      ...(result.stderr ? [`stderr: ${result.stderr}`] : []),
      ...(result.timedOut ? ["agent timed out"] : []),
    ],
    exitCode: result.exitCode,
    output: finalized.output,
    timedOut: result.timedOut,
  };
  return withOptionalHandoff(attemptResult, handoff);
}

function withOptionalHandoff(
  result: NodeAttemptResult,
  handoff: NodeHandoff | undefined
): NodeAttemptResult {
  return handoff ? { ...result, handoff } : result;
}

function profileRunner(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): string | undefined {
  return node.profile
    ? context.config.profiles[node.profile]?.runner
    : undefined;
}

/**
 * PIPE-83.1: derive a structured NodeHandoff for this node when context_handoff
 * is enabled. Fast-path reuses an already-handoff-shaped output; otherwise a
 * cheap read-only finalizer (mirroring createOutputRepairPlan) summarizes the
 * raw output, falling back to a synthesized minimal handoff. Returns undefined
 * when disabled so behaviour is unchanged.
 */
async function maybeDeriveHandoff(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number
): Promise<NodeHandoff | undefined> {
  if (!context.config.context_handoff?.enabled) {
    return;
  }
  // Fast-path an already-handoff-shaped output; otherwise run the finalizer.
  return (
    parseHandoff(rawOutput) ??
    (await runHandoffFinalizer(context, node, rawOutput, attempt))
  );
}

async function runHandoffFinalizer(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number
): Promise<NodeHandoff> {
  const runner = profileRunner(context, node);
  if (!(runner && rawOutput.trim())) {
    return synthesizeMinimalHandoff(rawOutput);
  }
  const plan = createHandoffFinalizerPlan(context, node, runner, rawOutput);
  context.agentInvocations.push(plan);
  emitAgentStart(context, plan, attempt);
  const result = await context.executor(plan, { signal: context.signal });
  emitAgentFinish(context, plan, attempt, result);
  const normalized = normalizeAgentOutput(plan, result.stdout);
  return parseHandoff(normalized.output) ?? synthesizeMinimalHandoff(rawOutput);
}

function createHandoffFinalizerPlan(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  runner: string,
  rawOutput: string
): RunnerLaunchPlan {
  const finalizerProfileId = `${node.id}:handoff`;
  const finalizerConfig: PipelineConfig = {
    ...context.config,
    profiles: {
      ...context.config.profiles,
      [finalizerProfileId]: {
        filesystem: { mode: "read-only" },
        instructions: {
          inline: "Summarize the agent output into a NodeHandoff JSON.",
        },
        network: { mode: "disabled" },
        output: { format: "text" },
        runner,
        tools: [],
      },
    },
  };
  const model = context.config.context_handoff?.model;
  return createRunnerLaunchPlan(finalizerConfig, {
    nodeId: finalizerProfileId,
    profileId: finalizerProfileId,
    prompt: handoffFinalizerPrompt(rawOutput),
    worktreePath: context.worktreePath,
    ...(model ? { model } : {}),
  });
}

interface NodeModelDecision {
  estimatedTokens: number;
  overBudget: boolean;
  selection: ModelSelection;
}

/**
 * Pure model-routing decision for a node: estimate the assembled prompt size and
 * pick the smallest fallback model whose window holds it within the context cap.
 * A node with no fallback array keeps the legacy (size-unaware) selection. A node
 * with a fallback array but no fitting model is `overBudget` — the caller fails
 * it fast rather than truncating.
 */
function decideNodeModel(
  prompt: string,
  node: PlannedWorkflowNode,
  budget: PipelineConfig["token_budget"] | undefined
): NodeModelDecision {
  const estimatedTokens = estimateTokens(prompt);
  if (!(budget && node.models?.length)) {
    return {
      estimatedTokens,
      overBudget: false,
      selection: selectNodeModel(node),
    };
  }
  const selection = selectNodeModel(node, { budget, estimatedTokens });
  return { estimatedTokens, overBudget: !selection.model, selection };
}

async function finalizeAgentOutput(inputs: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  normalized: { evidence: string[]; output: string };
  plan: RunnerLaunchPlan;
  result: AgentResult;
}): Promise<{ evidence: string[]; output: string }> {
  const { attempt, context, node, normalized, plan, result } = inputs;
  const validStructuredOutput = selectValidStructuredOutput(
    context,
    node,
    normalized,
    plan,
    result.stdout
  );
  if (validStructuredOutput) {
    return validStructuredOutput;
  }
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

function selectValidStructuredOutput(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  plan: RunnerLaunchPlan,
  stdout: string
): { evidence: string[]; output: string } | null {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  const output = profile?.output;
  if (output?.format !== "json_schema" || !output.schema_path) {
    return null;
  }
  const candidates = structuredOutputCandidates(plan, stdout, normalized);
  for (const candidate of candidates) {
    const candidateOutput = normalizeJsonSource(candidate.output);
    const validation = validateJsonSchemaSource(
      candidateOutput,
      output.schema_path,
      context.worktreePath
    );
    if (validation.passed) {
      return {
        evidence: [
          candidate.evidence,
          `selected valid structured output for ${node.id}`,
        ],
        output: candidateOutput,
      };
    }
  }
  return null;
}

function structuredOutputCandidates(
  plan: RunnerLaunchPlan,
  stdout: string,
  normalized: { evidence: string[]; output: string }
): Array<{ evidence: string; output: string }> {
  const candidates = runnerTextCandidates(plan, stdout);
  if (candidates.length > 0) {
    return [...candidates].reverse();
  }
  return [
    {
      evidence: normalized.evidence.join("; ") || "selected runner stdout",
      output: normalized.output,
    },
  ];
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
    const repairedOutput = normalizeJsonSource(repaired.output);
    const repairedValidation = validateJsonSchemaSource(
      repairedOutput,
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
      output: repairedOutput,
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
        output: repairedOutput,
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
  const schema = readJsonSchemaSource(schemaPath, context.worktreePath);
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

// PIPE-83.5: ranked code-context map (PIPE-83.2), seeded by the node's task and
// its dependencies' handoff artifacts. Empty (and skipped) unless repo_map is on.
async function repoMapSection(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<string> {
  const repoMap = context.config.repo_map;
  if (!repoMap?.enabled) {
    return "";
  }
  // Best-effort: a repo-map failure (parse/fs/ranking) must never break a run.
  try {
    const result = await buildRepoMapContext({
      artifacts: node.needs.flatMap(
        (need) => context.nodeStateStore.handoff(need)?.artifacts ?? []
      ),
      taskText: context.task,
      tokenBudget: repoMap.token_budget,
      worktreePath: context.worktreePath,
    });
    return result.context;
  } catch {
    return "";
  }
}

async function renderAgentPrompt(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<string> {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  const instructions = profile
    ? readInstructions(context.worktreePath, profile.instructions)
    : "";
  const repoMap = await repoMapSection(node, context);
  return [
    instructions.trim(),
    "",
    repoMap,
    `Task: ${context.task}`,
    `Workflow: ${context.workflowId}`,
    `Node: ${node.id}`,
    node.profile ? `Profile: ${node.profile}` : "",
    renderTaskContext(effectiveTaskContext(node, context)),
    renderProfileOutputContract(profile, context.worktreePath),
    renderGateOutputContract(node),
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
    renderMcpReferences(context.config, profile),
    "",
    ...inheritedOutputSections(node, context),
    "Dependency outputs:",
    ...node.needs.map((need) => renderDependencySection(need, context)),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * PIPE-83.5: render a dependency's curated NodeHandoff when one was derived
 * (PIPE-83.1), otherwise fall back to its raw output text. The fallback keeps
 * behaviour identical when context_handoff is disabled (no handoffs recorded).
 */
function renderDependencySection(
  nodeId: string,
  context: Pick<RuntimeContext, "nodeStateStore">
): string {
  const handoff = context.nodeStateStore.handoff(nodeId);
  return handoff
    ? renderHandoff(nodeId, handoff)
    : `## ${nodeId}\n${context.nodeStateStore.outputText(nodeId)}`;
}

function renderGateOutputContract(node: PlannedWorkflowNode): string {
  const gates = node.gates ?? [];
  const hasAcceptanceGate = gates.some(
    (gate) =>
      gate.kind === "acceptance" &&
      (gate.target === undefined || gate.target === "stdout")
  );
  const hasVerdictGate = gates.some(
    (gate) =>
      gate.kind === "verdict" &&
      (gate.target === undefined || gate.target === "stdout")
  );
  if (hasAcceptanceGate) {
    return [
      "",
      "Gate output contract:",
      "Return only valid JSON. Do not use Markdown fences or add prose outside the JSON object.",
      'Top-level fields: "verdict" ("PASS" or "FAIL"), "evidence" (string array), "acceptance" (array), optional "violations" (string array).',
      'Each "acceptance" entry must include "id", "verdict" ("PASS" or "FAIL"), and non-empty "evidence" (string array) for every canonical acceptance criterion id.',
      'Use top-level "verdict":"PASS" only when every required acceptance criterion passes with evidence.',
    ].join("\n");
  }
  if (hasVerdictGate) {
    return [
      "",
      "Gate output contract:",
      "Return only valid JSON. Do not use Markdown fences or add prose outside the JSON object.",
      'Top-level fields: "verdict" ("PASS" or "FAIL"), "evidence" (string array), optional "violations" (string array).',
      'Use "verdict":"PASS" only when the verification or review passes.',
    ].join("\n");
  }
  return "";
}

function renderProfileOutputContract(
  profile: PipelineConfig["profiles"][string] | undefined,
  worktreePath: string
): string {
  const output = profile?.output;
  if (output?.format !== "json_schema" || !output.schema_path) {
    return "";
  }
  const schema = readJsonSchemaSource(output.schema_path, worktreePath);
  return [
    "",
    "Profile output contract:",
    "Return only valid JSON matching the expected schema.",
    "Do not use Markdown fences or add prose outside the JSON object.",
    "",
    "Expected schema:",
    schema,
  ].join("\n");
}

function effectiveTaskContext(
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "taskContext">
): PipelineTaskContext | undefined {
  return node.taskContext ?? context.taskContext;
}

// fallow-ignore-next-line unused-export
export function inheritedOutputSections(
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "nodeStateStore">
): string[] {
  const inherited = context.nodeStateStore.inheritedOutputIdsExcluding(
    node.needs
  );
  if (inherited.length === 0) {
    return [];
  }
  return [
    "Inherited dependency outputs:",
    ...inherited.map((id) => renderDependencySection(id, context)),
    "",
  ];
}

// fallow-ignore-next-line unused-export
export function renderTaskContext(
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
  registry: Record<
    string,
    { path: string; source_root?: "package" | "project" }
  >,
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
        resolveRuntimePathReference(worktreePath, ref),
        "utf8"
      ).trimEnd();
      return [`## ${id}`, `Path: ${path}`, "", content].join("\n");
    }),
  ].join("\n");
}

function resolveRuntimePathReference(
  worktreePath: string,
  ref: { path?: string; source_root?: "package" | "project" } | undefined
): string {
  if (ref?.source_root === "package") {
    return resolvePackageAssetPath(ref.path);
  }
  return resolveFileReference(worktreePath, ref?.path ?? "");
}

function renderMcpReferences(
  config: PipelineConfig,
  profile: PipelineConfig["profiles"][string] | undefined
): string {
  const servers = gatewayServerForProfile(config, profile);
  if (Object.keys(servers).length === 0) {
    return "";
  }
  return [
    "",
    "Loaded MCP servers:",
    ...Object.entries(servers).map(([id, server]) => {
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
