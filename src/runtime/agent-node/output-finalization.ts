import { Effect, Option, pipe } from "effect";

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

const firstValidStructuredCandidate = (inputs: {
  candidates: { evidence: string; output: string }[];
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  schemaPath: string;
}): Option.Option<{ evidence: string[]; output: string }> => {
  for (const candidate of inputs.candidates) {
    const candidateOutput = normalizeJsonSource(candidate.output);
    const validation = validateJsonSchemaSource(
      candidateOutput,
      inputs.schemaPath,
      inputs.context.worktreePath
    );
    if (validation.passed) {
      return Option.some({
        evidence: [
          candidate.evidence,
          `selected valid structured output for ${inputs.node.id}`,
        ],
        output: candidateOutput,
      });
    }
  }
  return Option.none();
};

const structuredOutputCandidates = (
  plan: RunnerLaunchPlan,
  stdout: string,
  normalized: { evidence: string[]; output: string }
): { evidence: string; output: string }[] => {
  const candidates = runnerTextCandidates(plan, stdout);
  if (candidates.length > 0) {
    return [...candidates].toReversed();
  }
  return [
    {
      evidence: normalized.evidence.join("; ") || "selected runner stdout",
      output: normalized.output,
    },
  ];
};

const successfulAgentResult = (result: AgentResult): boolean =>
  result.exitCode === 0 && result.timedOut !== true;

const nodeProfile = (
  context: RuntimeContext,
  node: PlannedWorkflowNode
): Option.Option<AgentProfile> => {
  if (node.profile === undefined || node.profile.length === 0) {
    return Option.none();
  }
  return Option.fromUndefinedOr(context.config.profiles[node.profile]);
};

const jsonSchemaOutputConfig = (
  output: Option.Option<OutputConfig>
): Option.Option<JsonSchemaOutputConfig> =>
  pipe(
    output,
    Option.flatMap((value) => {
      if (value.format !== "json_schema") {
        return Option.none();
      }
      const schemaPath = value.schema_path;
      if (schemaPath === undefined || schemaPath.length === 0) {
        return Option.none();
      }
      return Option.some({
        ...value,
        format: "json_schema",
        schema_path: schemaPath,
      });
    })
  );

const jsonSchemaOutput = (
  profile: Option.Option<AgentProfile>
): Option.Option<JsonSchemaOutputConfig> =>
  pipe(
    profile,
    Option.flatMap((value) =>
      jsonSchemaOutputConfig(Option.fromUndefinedOr(value.output))
    )
  );

const nodeSchemaOutput = (
  context: RuntimeContext,
  node: PlannedWorkflowNode
): Option.Option<NodeSchemaOutput> => {
  const profile = nodeProfile(context, node);
  return pipe(
    profile,
    Option.flatMap((value) =>
      pipe(
        jsonSchemaOutput(Option.some(value)),
        Option.map((output) => ({
          output,
          profile: value,
          schemaPath: output.schema_path,
        }))
      )
    )
  );
};

const nodeOutputSchemaPath = (
  context: RuntimeContext,
  node: PlannedWorkflowNode
): Option.Option<string> =>
  pipe(
    nodeSchemaOutput(context, node),
    Option.map((output) => output.schemaPath)
  );

const selectValidStructuredOutput = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  plan: RunnerLaunchPlan,
  stdout: string
): Option.Option<{ evidence: string[]; output: string }> =>
  pipe(
    nodeOutputSchemaPath(context, node),
    Option.flatMap((schemaPath) =>
      firstValidStructuredCandidate({
        candidates: structuredOutputCandidates(plan, stdout, normalized),
        context,
        node,
        schemaPath,
      })
    )
  );

const repairEvidence = (
  repairedEvidence: string[],
  validation: JsonSchemaValidationResult,
  nodeId: string,
  attempt: number,
  passed: boolean
): string[] => [
  ...repairedEvidence,
  passed
    ? `output repair passed for ${nodeId} after attempt ${attempt}`
    : `output repair failed for ${nodeId} after attempt ${attempt}`,
  ...validation.evidence.map((item) => `repaired output: ${item}`),
];

const emitRepairEvent = (
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  passed: boolean,
  validation: JsonSchemaValidationResult
): void => {
  emit(context, {
    attempt,
    nodeId,
    passed,
    type: "output.repair",
    ...(passed ? {} : { reason: validation.reason ?? "repair failed" }),
  });
};

const defaultRepairOptions = (): RepairOptions => ({
  enabled: true,
  maxAttempts: 1,
});

const withRepairRunner = (
  options: Omit<RepairOptions, "runner">,
  runner?: string
): RepairOptions =>
  runner === undefined || runner.length === 0
    ? options
    : { ...options, runner };

const configuredRepairOptions = (repair: OutputRepairConfig): RepairOptions => {
  const options = {
    enabled: repair.enabled ?? true,
    maxAttempts: repair.max_attempts ?? 1,
  };
  return withRepairRunner(options, repair.runner);
};

const outputRepairOptions = (output: JsonSchemaOutputConfig): RepairOptions =>
  output.repair === undefined
    ? defaultRepairOptions()
    : configuredRepairOptions(output.repair);

const failedRepairableOutputContext = (inputs: {
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  normalized: { evidence: string[]; output: string };
  output: JsonSchemaOutputConfig;
  profile: AgentProfile;
  schemaPath: string;
}): Option.Option<OutputRepairContext> => {
  const validation = validateJsonSchemaSource(
    inputs.normalized.output,
    inputs.schemaPath,
    inputs.context.worktreePath
  );
  const repair = outputRepairOptions(inputs.output);
  if (validation.passed || !repair.enabled) {
    return Option.none();
  }
  return Option.some({
    evidence: [
      ...inputs.normalized.evidence,
      "output repair triggered",
      ...validation.evidence.map((item) => `original output: ${item}`),
    ],
    maxAttempts: repair.maxAttempts,
    runner: repair.runner ?? inputs.profile.runner,
    schemaPath: inputs.schemaPath,
    validation,
  });
};

const outputRepairContext = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  result: AgentResult
): Option.Option<OutputRepairContext> => {
  if (!successfulAgentResult(result)) {
    return Option.none();
  }
  const schemaOutput = nodeSchemaOutput(context, node);
  return pipe(
    schemaOutput,
    Option.flatMap((output) =>
      failedRepairableOutputContext({
        context,
        node,
        normalized,
        ...output,
      })
    )
  );
};

const outputRepairPrompt = (
  schema: string,
  validation: JsonSchemaValidationResult,
  originalOutput: string
): string =>
  [
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

const createOutputRepairPlan = (inputs: {
  context: RuntimeContext;
  node: PlannedWorkflowNode;
  originalOutput: string;
  repairRunner: string;
  schemaPath: string;
  validation: JsonSchemaValidationResult;
}): RunnerLaunchPlan => {
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
};

export const normalizeAgentOutput = (
  plan: RunnerLaunchPlan,
  stdout: string
): { evidence: string[]; output: string } =>
  normalizeRunnerOutput(plan, stdout);

const repairedOutputState = (
  repairPlan: RunnerLaunchPlan,
  repairResult: AgentResult,
  schemaPath: string,
  worktreePath: string
): {
  latest: { evidence: string[]; output: string };
  latestValidation: JsonSchemaValidationResult;
} => {
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
        ...(repairResult.stderr !== undefined && repairResult.stderr.length > 0
          ? [`repair stderr: ${repairResult.stderr}`]
          : []),
        ...(repairResult.timedOut === true ? ["output repair timed out"] : []),
      ],
      output: repairedOutput,
    },
    latestValidation,
  };
};

const runSingleRepairAttempt = (inputs: {
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
> =>
  Effect.gen(function* effectBody() {
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
    const { latest, latestValidation } = repairedOutputState(
      repairPlan,
      repairResult,
      inputs.repairContext.schemaPath,
      inputs.context.worktreePath
    );
    const passed = repairResult.exitCode === 0 && latestValidation.passed;
    emitRepairEvent(
      inputs.context,
      inputs.node.id,
      inputs.attempt,
      passed,
      latestValidation
    );
    return {
      evidence: repairEvidence(
        latest.evidence,
        latestValidation,
        inputs.node.id,
        inputs.attempt,
        passed
      ),
      latest,
      latestValidation,
      passed,
    };
  });

const runOutputRepairEffect = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  normalized: { evidence: string[]; output: string },
  repairContext: OutputRepairContext,
  nodeAttempt: number
): Effect.Effect<
  { evidence: string[]; output: string },
  unknown,
  AgentNodeRuntimeService
> =>
  Effect.gen(function* effectBody() {
    let latest = normalized;
    let latestValidation = repairContext.validation;
    const evidence = [...repairContext.evidence];
    for (let attempt = 1; attempt <= repairContext.maxAttempts; attempt += 1) {
      const {
        evidence: repairEvidenceItems,
        latest: repairedLatest,
        latestValidation: repairedLatestValidation,
        passed,
      } = yield* runSingleRepairAttempt({
        attempt,
        context,
        latest,
        latestValidation,
        node,
        nodeAttempt,
        repairContext,
      });
      latest = repairedLatest;
      latestValidation = repairedLatestValidation;
      evidence.push(...repairEvidenceItems);
      if (passed) {
        return { evidence, output: repairedLatest.output };
      }
    }
    return { evidence, output: latest.output };
  });

export const finalizeAgentOutputEffect = (inputs: {
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
> =>
  Effect.gen(function* effectBody() {
    const { attempt, context, node, normalized, plan, result } = inputs;
    const validStructuredOutput = selectValidStructuredOutput(
      context,
      node,
      normalized,
      plan,
      result.stdout
    );
    const structuredOutput = Option.getOrUndefined(validStructuredOutput);
    if (structuredOutput !== undefined) {
      return structuredOutput;
    }
    const repairContext = outputRepairContext(
      context,
      node,
      normalized,
      result
    );
    const repair = Option.getOrUndefined(repairContext);
    if (repair === undefined) {
      return normalized;
    }

    return yield* runOutputRepairEffect(
      context,
      node,
      normalized,
      repair,
      attempt
    );
  });
