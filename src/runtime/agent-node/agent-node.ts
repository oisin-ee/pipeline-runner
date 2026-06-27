import { Effect } from "effect";
import type { PipelineConfig } from "../../config";
import { gatewayServerForProfile } from "../../mcp/gateway-config";
import { selectNodeModelCandidates } from "../../model-resolver";
import { resolvePackageAssetPath } from "../../package-assets";
import { resolveFileReference } from "../../path-refs";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
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
import { EXIT_INFRA } from "../exit-codes";
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
import {
  AgentNodeRuntimeService,
  AgentNodeRuntimeServiceLive,
} from "../services/agent-node-runtime-service";

export function executeAgentNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Promise<NodeAttemptResult> {
  const program = executeAgentNodeEffect(node, context, attempt);
  return Effect.runPromise(
    Effect.provide(program, AgentNodeRuntimeServiceLive)
  );
}

function executeAgentNodeEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> {
  // fallow-ignore-next-line complexity
  return Effect.gen(function* () {
    if (!node.profile) {
      return {
        evidence: [`node '${node.id}' has no profile`],
        exitCode: 1,
        output: "",
      };
    }
    const prompt = yield* renderAgentPromptEffect(node, context);
    const decision = decideNodeModel(
      prompt,
      node,
      context.config.token_budget,
      context.availableModels
    );
    if (decision.overBudget) {
      return {
        evidence: [
          `agent boundary node=${node.id} profile=${node.profile}`,
          `over token budget: ${decision.reason}`,
          ...(decision.skipped.length
            ? [`model fallbacks skipped: ${decision.skipped.join(", ")}`]
            : []),
        ],
        exitCode: 1,
        output: "",
      };
    }
    const profileId = node.profile;
    // The model array is a fallback set: try each candidate in declared order,
    // moving on only when one's session fails at runtime with an infra error
    // (provider/server down). All non-infra outcomes — success, or a genuine
    // agent-task error — belong to a model that actually ran, so they are the
    // node's result and stop the walk. The final candidate is always the
    // result, infra or not, so an exhausted set surfaces as the real failure.
    const fallbackEvidence: string[] = [];
    const lastIndex = decision.candidates.length - 1;
    for (let index = 0; index < lastIndex; index += 1) {
      const model = decision.candidates[index];
      const attemptOutcome = yield* runModelAttemptEffect({
        attempt,
        context,
        model,
        node,
        profileId,
        prompt,
      });
      if (attemptOutcome.result.exitCode !== EXIT_INFRA) {
        return yield* buildAgentAttemptResultEffect({
          attempt,
          context,
          decision,
          fallbackEvidence,
          model,
          node,
          outcome: attemptOutcome,
          profileId,
        });
      }
      fallbackEvidence.push(
        fallbackNote(
          model,
          decision.candidates[index + 1],
          attemptOutcome.result
        )
      );
    }
    const lastModel = decision.candidates[lastIndex];
    const lastOutcome = yield* runModelAttemptEffect({
      attempt,
      context,
      model: lastModel,
      node,
      profileId,
      prompt,
    });
    return yield* buildAgentAttemptResultEffect({
      attempt,
      context,
      decision,
      fallbackEvidence,
      model: lastModel,
      node,
      outcome: lastOutcome,
      profileId,
    });
  });
}

function modelLabel(model: string | undefined): string {
  return model ?? "profile/default";
}

function fallbackNote(
  failed: string | undefined,
  next: string | undefined,
  result: AgentResult
): string {
  const detail = result.stderr ? `: ${result.stderr}` : "";
  return `model ${modelLabel(failed)} failed (infra exit ${result.exitCode}${detail}); falling back to ${modelLabel(next)}`;
}

interface ModelAttemptOutcome {
  plan: RunnerLaunchPlan;
  result: AgentResult;
}

function runModelAttemptEffect(inputs: {
  attempt: number;
  context: RuntimeContext;
  model: string | undefined;
  node: PlannedWorkflowNode;
  profileId: string;
  prompt: string;
}): Effect.Effect<ModelAttemptOutcome, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const { attempt, context, model, node, profileId, prompt } = inputs;
    const service = yield* AgentNodeRuntimeService;
    const plan = createRunnerLaunchPlan(context.config, {
      model,
      nodeId: node.id,
      profileId,
      prompt,
      reasoningEffort: node.reasoning_effort,
      worktreePath: context.worktreePath,
    });
    if (node.timeoutMs) {
      plan.timeoutMs = node.timeoutMs;
    }
    context.agentInvocations.push(plan);
    emitAgentStart(context, plan, attempt);
    const result = yield* service.executeRunner(context.executor, plan, {
      onOutput: agentOutputRecorder(context, node, attempt),
      signal: context.signal,
    });
    emitAgentFinish(context, plan, attempt, result);
    if (result.sessionId) {
      context.nodeStateStore.recordSessionId(node.id, result.sessionId);
    }
    return { plan, result };
  });
}

function buildAgentAttemptResultEffect(inputs: {
  attempt: number;
  context: RuntimeContext;
  decision: NodeModelDecision;
  fallbackEvidence: string[];
  model: string | undefined;
  node: PlannedWorkflowNode;
  outcome: ModelAttemptOutcome;
  profileId: string;
}): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const {
      attempt,
      context,
      decision,
      fallbackEvidence,
      model,
      node,
      outcome,
      profileId,
    } = inputs;
    const { plan, result } = outcome;
    const normalized = normalizeAgentOutput(plan, result.stdout);
    const finalized = yield* finalizeAgentOutputEffect({
      context,
      node,
      normalized,
      plan,
      result,
      attempt,
    });
    const handoff = yield* maybeDeriveHandoffEffect(
      context,
      node,
      finalized.output,
      attempt
    );
    const attemptResult: NodeAttemptResult = {
      evidence: [
        `agent boundary node=${node.id} profile=${profileId} runner=${plan.runnerId}`,
        `estimated context tokens: ${decision.estimatedTokens}`,
        `model selection: ${modelLabel(model)} (${decision.reason})`,
        ...(decision.skipped.length
          ? [`model fallbacks skipped: ${decision.skipped.join(", ")}`]
          : []),
        ...fallbackEvidence,
        ...finalized.evidence,
        ...(result.stderr ? [`stderr: ${result.stderr}`] : []),
        ...(result.timedOut ? ["agent timed out"] : []),
      ],
      exitCode: result.exitCode,
      output: finalized.output,
      timedOut: result.timedOut,
    };
    return withOptionalHandoff(attemptResult, handoff);
  });
}

function agentOutputRecorder(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  attempt: number
) {
  return (event: { chunk: string; stream: "stderr" | "stdout" }) => {
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
  };
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
function maybeDeriveHandoffEffect(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number
): Effect.Effect<NodeHandoff | undefined, unknown, AgentNodeRuntimeService> {
  if (!context.config.context_handoff?.enabled) {
    return Effect.succeed(undefined);
  }
  const handoff = parseHandoff(rawOutput);
  return handoff
    ? Effect.succeed(handoff)
    : runHandoffFinalizerEffect(context, node, rawOutput, attempt);
}

function runHandoffFinalizerEffect(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number
): Effect.Effect<NodeHandoff, never, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const runner = profileRunner(context, node);
    if (!(runner && rawOutput.trim())) {
      return synthesizeMinimalHandoff(rawOutput);
    }
    const plan = createHandoffFinalizerPlan(context, node, runner, rawOutput);
    context.agentInvocations.push(plan);
    emitAgentStart(context, plan, attempt);
    const service = yield* AgentNodeRuntimeService;
    const result = yield* service.executeRunner(context.executor, plan, {
      signal: context.signal,
    });
    emitAgentFinish(context, plan, attempt, result);
    const normalized = normalizeAgentOutput(plan, result.stdout);
    return (
      parseHandoff(normalized.output) ?? synthesizeMinimalHandoff(rawOutput)
    );
    // The handoff finalizer is best-effort: a failed/erroring finalizer agent
    // must degrade to a minimal handoff, never hard-fail the node (matches the
    // pre-Effect behaviour; the conversion had dropped this recovery).
  }).pipe(
    Effect.catch(() => Effect.succeed(synthesizeMinimalHandoff(rawOutput)))
  );
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
  /**
   * Ordered models to attempt, declared priority first. A lone `undefined`
   * means "use the profile's default model" — the node declared no fallback
   * array, or every declared model was filtered out, so there is one attempt
   * on whatever the profile resolves.
   */
  candidates: (string | undefined)[];
  estimatedTokens: number;
  overBudget: boolean;
  reason: string;
  skipped: string[];
}

/**
 * Pure model-routing decision for a node: estimate the assembled prompt size and
 * resolve the ordered fallback set of models whose window holds it within the
 * context cap. A node with no fallback array (or none surviving the filters)
 * falls back to the profile default (`undefined`). A node with a fallback array
 * but no fitting model under budget is `overBudget` — the caller fails it fast
 * rather than truncating.
 */
function decideNodeModel(
  prompt: string,
  node: PlannedWorkflowNode,
  budget: PipelineConfig["token_budget"] | undefined,
  availableModels: ReadonlySet<string> | undefined
): NodeModelDecision {
  const estimatedTokens = estimateTokens(prompt);
  const sizing = budget ? { budget, estimatedTokens } : {};
  const candidates = selectNodeModelCandidates(node, {
    available: availableModels,
    ...sizing,
  });
  const overBudget =
    Boolean(budget && node.models?.length) && candidates.models.length === 0;
  return {
    candidates: candidates.models.length ? candidates.models : [undefined],
    estimatedTokens,
    overBudget,
    reason: candidates.reason,
    skipped: candidates.skipped,
  };
}

function finalizeAgentOutputEffect(inputs: {
  attempt: number;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  normalized: { evidence: string[]; output: string };
  plan: RunnerLaunchPlan;
  result: AgentResult;
}): Effect.Effect<
  { evidence: string[]; output: string },
  unknown,
  AgentNodeRuntimeService
> {
  return Effect.gen(function* () {
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
    const repairContext = outputRepairContext(
      context,
      node,
      normalized,
      result
    );
    if (!repairContext) {
      return normalized;
    }

    return yield* runOutputRepairEffect(
      context,
      node,
      normalized,
      repairContext,
      attempt
    );
  });
}

// fallow-ignore-next-line complexity
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

// fallow-ignore-next-line complexity
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

function runOutputRepairEffect(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  repairContext: OutputRepairContext,
  nodeAttempt: number
): Effect.Effect<
  { evidence: string[]; output: string },
  unknown,
  AgentNodeRuntimeService
> {
  // fallow-ignore-next-line complexity
  return Effect.gen(function* () {
    let latest = normalized;
    let latestValidation = repairContext.validation;
    const evidence = [...repairContext.evidence];
    const service = yield* AgentNodeRuntimeService;
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
      const repairResult = yield* service.executeRunner(
        context.executor,
        repairPlan,
        {
          signal: context.signal,
        }
      );
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
  });
}

// fallow-ignore-next-line complexity
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
function repoMapSectionEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<string, never, AgentNodeRuntimeService> {
  const repoMap = context.config.repo_map;
  if (!repoMap?.enabled) {
    return Effect.succeed("");
  }
  return Effect.gen(function* () {
    const service = yield* AgentNodeRuntimeService;
    const result = yield* Effect.tryPromise({
      catch: () => "",
      try: () =>
        service.buildRepoMap({
          artifacts: node.needs.flatMap(
            (need) => context.nodeStateStore.handoff(need)?.artifacts ?? []
          ),
          taskText: context.task,
          tokenBudget: repoMap.token_budget,
          worktreePath: context.worktreePath,
        }),
    });
    return result.context;
  }).pipe(Effect.catch(() => Effect.succeed("")));
}

function renderAgentPromptEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const profile = node.profile
      ? context.config.profiles[node.profile]
      : undefined;
    const instructions = profile
      ? yield* readInstructionsEffect(
          context.worktreePath,
          profile.instructions
        )
      : "";
    const repoMap = yield* repoMapSectionEffect(node, context);
    const pathReferences = yield* renderProfilePathReferences(profile, context);
    return agentPromptSections({
      context,
      instructions,
      node,
      pathReferences,
      profile,
      repoMap,
    })
      .filter(Boolean)
      .join("\n");
  });
}

// fallow-ignore-next-line complexity
function agentPromptSections(inputs: {
  context: RuntimeContext;
  instructions: string;
  node: PlannedWorkflowNode;
  pathReferences: string[];
  profile: PipelineConfig["profiles"][string] | undefined;
  repoMap: string;
}): string[] {
  const { context, instructions, node, pathReferences, profile, repoMap } =
    inputs;
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
    ...pathReferences,
    renderMcpReferences(context.config, profile),
    "",
    ...inheritedOutputSections(node, context),
    "Dependency outputs:",
    ...node.needs.map((need) => renderDependencySection(need, context)),
  ];
}

function renderProfilePathReferences(
  profile: PipelineConfig["profiles"][string] | undefined,
  context: RuntimeContext
): Effect.Effect<string[], unknown, AgentNodeRuntimeService> {
  return Effect.all([
    renderPathReferencesEffect(
      "Loaded rules",
      profile?.rules,
      context.config.rules,
      context.worktreePath
    ),
    renderPathReferencesEffect(
      "Loaded skills",
      profile?.skills,
      context.config.skills,
      context.worktreePath
    ),
  ]);
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

// fallow-ignore-next-line complexity
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

// fallow-ignore-next-line unused-export complexity
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

function readInstructionsEffect(
  worktreePath: string,
  instructions: PipelineConfig["profiles"][string]["instructions"]
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  if (instructions.inline) {
    return Effect.succeed(instructions.inline);
  }
  if (instructions.path) {
    const instructionPath = instructions.path;
    return AgentNodeRuntimeService.pipe(
      Effect.flatMap((service) =>
        service.readText(resolveFileReference(worktreePath, instructionPath))
      )
    );
  }
  return Effect.succeed("");
}

function renderPathReferencesEffect(
  heading: string,
  ids: string[] | undefined,
  registry: Record<
    string,
    { path: string; source_root?: "package" | "project" }
  >,
  worktreePath: string
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  if (!ids?.length) {
    return Effect.succeed("");
  }
  return Effect.gen(function* () {
    const sections = yield* Effect.all(
      ids.map((id) => renderPathReferenceEffect(id, registry, worktreePath))
    );
    return ["", `${heading}:`, ...sections].join("\n");
  });
}

function renderPathReferenceEffect(
  id: string,
  registry: Record<
    string,
    { path: string; source_root?: "package" | "project" }
  >,
  worktreePath: string
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  const ref = registry[id];
  const path = ref?.path ?? "";
  const resolved = resolveRuntimePathReference(worktreePath, ref);
  return AgentNodeRuntimeService.pipe(
    Effect.flatMap((service) => service.readText(resolved)),
    Effect.map((content) =>
      [`## ${id}`, `Path: ${path}`, "", content.trimEnd()].join("\n")
    ),
    // Install-managed harness assets (e.g. globally-installed skills) may not
    // have a readable body in this worktree; the host agent runtime loads them
    // natively, so reference them without inlining instead of failing the node.
    // readText surfaces a missing file as a defect (Effect.sync), so catch the
    // whole cause, not just the typed failure channel.
    Effect.catchCause(() =>
      Effect.succeed(
        [
          `## ${id}`,
          `Path: ${path}`,
          "",
          "(install-managed harness asset; loaded by the host agent runtime)",
        ].join("\n")
      )
    )
  );
}

// fallow-ignore-next-line complexity
function resolveRuntimePathReference(
  worktreePath: string,
  ref: { path?: string; source_root?: "package" | "project" } | undefined
): string {
  if (ref?.source_root === "package") {
    return resolvePackageAssetPath(ref.path ?? "");
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
    // fallow-ignore-next-line complexity
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
