import { Effect } from "effect";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import {
  normalizeRunnerOutput,
  runnerTextCandidates,
} from "../../runner-output";
import type {
  JsonSchemaValidationResult,
  OutputRepairContext,
  RuntimeContext,
} from "../contracts";
import { emit, emitAgentFinish, emitAgentStart } from "../events";
import {
  normalizeJsonSource,
  readJsonSchemaSource,
  validateJsonSchemaSource,
} from "../json-validation";
import { AgentNodeRuntimeService } from "../services/agent-node-runtime-service";

type AgentProfile = PipelineConfig["profiles"][string];
type OutputConfig = NonNullable<AgentProfile["output"]>;
type JsonSchemaOutputConfig = OutputConfig & {
  format: "json_schema";
  schema_path: string;
};
type OutputRepairConfig = NonNullable<OutputConfig["repair"]>;

interface NodeSchemaOutput {
  output: JsonSchemaOutputConfig;
  profile: AgentProfile;
  schemaPath: string;
}

interface RepairOptions {
  enabled: boolean;
  maxAttempts: number;
  runner?: string;
}

export function finalizeAgentOutputEffect(inputs: {
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

function selectValidStructuredOutput(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  plan: RunnerLaunchPlan,
  stdout: string
): { evidence: string[]; output: string } | null {
  const schemaPath = nodeOutputSchemaPath(context, node);
  if (!schemaPath) {
    return null;
  }
  return firstValidStructuredCandidate({
    candidates: structuredOutputCandidates(plan, stdout, normalized),
    context,
    node,
    schemaPath,
  });
}

function firstValidStructuredCandidate(inputs: {
  candidates: Array<{ evidence: string; output: string }>;
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  schemaPath: string;
}): { evidence: string[]; output: string } | null {
  for (const candidate of inputs.candidates) {
    const candidateOutput = normalizeJsonSource(candidate.output);
    const validation = validateJsonSchemaSource(
      candidateOutput,
      inputs.schemaPath,
      inputs.context.worktreePath
    );
    if (validation.passed) {
      return {
        evidence: [
          candidate.evidence,
          `selected valid structured output for ${inputs.node.id}`,
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
  if (!successfulAgentResult(result)) {
    return null;
  }
  const schemaOutput = nodeSchemaOutput(context, node);
  if (!schemaOutput) {
    return null;
  }
  return failedRepairableOutputContext({
    context,
    node,
    normalized,
    ...schemaOutput,
  });
}

function successfulAgentResult(result: AgentResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function nodeOutputSchemaPath(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): string | undefined {
  return nodeSchemaOutput(context, node)?.schemaPath;
}

function nodeSchemaOutput(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): NodeSchemaOutput | undefined {
  const profile = nodeProfile(context, node);
  const output = jsonSchemaOutput(profile);
  if (!profile) {
    return;
  }
  if (!output) {
    return;
  }
  return { output, profile, schemaPath: output.schema_path };
}

function nodeProfile(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): AgentProfile | undefined {
  return node.profile ? context.config.profiles[node.profile] : undefined;
}

function jsonSchemaOutput(
  profile: AgentProfile | undefined
): JsonSchemaOutputConfig | undefined {
  if (!profile) {
    return;
  }
  return jsonSchemaOutputConfig(profile.output);
}

function jsonSchemaOutputConfig(
  output: OutputConfig | undefined
): JsonSchemaOutputConfig | undefined {
  if (!output) {
    return;
  }
  if (output.format !== "json_schema") {
    return;
  }
  const schemaPath = output.schema_path;
  if (!schemaPath) {
    return;
  }
  return {
    ...output,
    format: "json_schema",
    schema_path: schemaPath,
  };
}

function failedRepairableOutputContext(inputs: {
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  normalized: { evidence: string[]; output: string };
  output: JsonSchemaOutputConfig;
  profile: AgentProfile;
  schemaPath: string;
}): OutputRepairContext | null {
  const validation = validateJsonSchemaSource(
    inputs.normalized.output,
    inputs.schemaPath,
    inputs.context.worktreePath
  );
  const repair = outputRepairOptions(inputs.output);
  if (validation.passed || !repair.enabled) {
    return null;
  }
  return {
    evidence: [
      ...inputs.normalized.evidence,
      "output repair triggered",
      ...validation.evidence.map((item) => `original output: ${item}`),
    ],
    maxAttempts: repair.maxAttempts,
    runner: repair.runner ?? inputs.profile.runner,
    schemaPath: inputs.schemaPath,
    validation,
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
  return Effect.gen(function* () {
    let latest = normalized;
    let latestValidation = repairContext.validation;
    const evidence = [...repairContext.evidence];
    for (let attempt = 1; attempt <= repairContext.maxAttempts; attempt += 1) {
      const repair = yield* runSingleRepairAttempt({
        attempt,
        context,
        latest,
        latestValidation,
        node,
        nodeAttempt,
        repairContext,
      });
      latest = repair.latest;
      latestValidation = repair.latestValidation;
      evidence.push(...repair.evidence);
      if (repair.passed) {
        return { evidence, output: repair.latest.output };
      }
    }
    return { evidence, output: latest.output };
  });
}

function runSingleRepairAttempt(inputs: {
  attempt: number;
  context: RuntimeContext;
  latest: { evidence: string[]; output: string };
  latestValidation: JsonSchemaValidationResult;
  node: PlannedWorkflowNode;
  nodeAttempt: number;
  repairContext: OutputRepairContext;
}): Effect.Effect<
  {
    evidence: string[];
    latest: { evidence: string[]; output: string };
    latestValidation: JsonSchemaValidationResult;
    passed: boolean;
  },
  unknown,
  AgentNodeRuntimeService
> {
  return Effect.gen(function* () {
    const service = yield* AgentNodeRuntimeService;
    const repairPlan = createOutputRepairPlan({
      context: inputs.context,
      node: inputs.node,
      originalOutput: inputs.latest.output,
      repairRunner: inputs.repairContext.runner,
      schemaPath: inputs.repairContext.schemaPath,
      validation: inputs.latestValidation,
    });
    inputs.context.agentInvocations.push(repairPlan);
    emitAgentStart(inputs.context, repairPlan, inputs.nodeAttempt);
    const repairResult = yield* service.executeRunner(
      inputs.context.executor,
      repairPlan,
      {
        signal: inputs.context.signal,
      }
    );
    emitAgentFinish(
      inputs.context,
      repairPlan,
      inputs.nodeAttempt,
      repairResult
    );
    const latest = repairedOutputState(
      repairPlan,
      repairResult,
      inputs.repairContext.schemaPath,
      inputs.context.worktreePath
    );
    const passed =
      repairResult.exitCode === 0 && latest.latestValidation.passed;
    emitRepairEvent(
      inputs.context,
      inputs.node.id,
      inputs.attempt,
      passed,
      latest.latestValidation
    );
    return {
      evidence: repairEvidence(
        latest.latest.evidence,
        latest.latestValidation,
        inputs.node.id,
        inputs.attempt,
        passed
      ),
      latest: latest.latest,
      latestValidation: latest.latestValidation,
      passed,
    };
  });
}

function repairedOutputState(
  repairPlan: RunnerLaunchPlan,
  repairResult: AgentResult,
  schemaPath: string,
  worktreePath: string
): {
  latest: { evidence: string[]; output: string };
  latestValidation: JsonSchemaValidationResult;
} {
  const repaired = normalizeAgentOutput(repairPlan, repairResult.stdout);
  const repairedOutput = normalizeJsonSource(repaired.output);
  const latestValidation = validateJsonSchemaSource(
    repairedOutput,
    schemaPath,
    worktreePath
  );
  return {
    latest: {
      evidence: [
        ...repaired.evidence,
        ...(repairResult.stderr
          ? [`repair stderr: ${repairResult.stderr}`]
          : []),
        ...(repairResult.timedOut ? ["output repair timed out"] : []),
      ],
      output: repairedOutput,
    },
    latestValidation,
  };
}

function repairEvidence(
  repairedEvidence: string[],
  validation: JsonSchemaValidationResult,
  nodeId: string,
  attempt: number,
  passed: boolean
): string[] {
  return [
    ...repairedEvidence,
    passed
      ? `output repair passed for ${nodeId} after attempt ${attempt}`
      : `output repair failed for ${nodeId} after attempt ${attempt}`,
    ...validation.evidence.map((item) => `repaired output: ${item}`),
  ];
}

function emitRepairEvent(
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  passed: boolean,
  validation: JsonSchemaValidationResult
): void {
  emit(context, {
    attempt,
    nodeId,
    passed,
    type: "output.repair",
    ...(passed ? {} : { reason: validation.reason ?? "repair failed" }),
  });
}

function outputRepairOptions(output: JsonSchemaOutputConfig): RepairOptions {
  return output.repair
    ? configuredRepairOptions(output.repair)
    : defaultRepairOptions();
}

function defaultRepairOptions(): RepairOptions {
  return { enabled: true, maxAttempts: 1 };
}

function configuredRepairOptions(repair: OutputRepairConfig): RepairOptions {
  const options = {
    enabled: repair.enabled ?? true,
    maxAttempts: repair.max_attempts ?? 1,
  };
  return withRepairRunner(options, repair.runner);
}

function withRepairRunner(
  options: Omit<RepairOptions, "runner">,
  runner: string | undefined
): RepairOptions {
  return runner ? { ...options, runner } : options;
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
  return createRunnerLaunchPlan(repairConfig, {
    nodeId: repairProfileId,
    profileId: repairProfileId,
    prompt: outputRepairPrompt(schema, validation, originalOutput),
    worktreePath: context.worktreePath,
  });
}

function outputRepairPrompt(
  schema: string,
  validation: JsonSchemaValidationResult,
  originalOutput: string
): string {
  return [
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
}

export function normalizeAgentOutput(
  plan: RunnerLaunchPlan,
  stdout: string
): { evidence: string[]; output: string } {
  return normalizeRunnerOutput(plan, stdout);
}
