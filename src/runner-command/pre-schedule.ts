import { readFile } from "node:fs/promises";

import type { Scope } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PipelineConfig } from "../config";
import { resolveFileReference } from "../path-refs";
import { compileScheduleArtifact, generateScheduleArtifactInMemory } from "../planning/generate";
import type { SchedulePhaseContext } from "../planning/generate";
import { createRunnerLaunchPlan } from "../runner";
import type { AgentResult } from "../runner";
import type { RunnerCommandPayload } from "../runner-command-contract";
import { normalizeRunnerOutput } from "../runner-output";
import { runLaunchPlan } from "../runner/subprocess";
import type { RuntimeNodeResult } from "../runtime/contracts";
import { isOutputStream } from "../runtime/services/runner-command-io-service";
import type { OutputStream, RunnerCommandIoService } from "../runtime/services/runner-command-io-service";
import { recordNodeResult } from "../runtime/step/step-node";
import { mutableArray, parseResultWithSchema, parseStrictWithSchema, requiredString, struct } from "../schema-boundary";
import { parseTicketPlanEffect, ticketPlanSchema } from "../tickets/ticket-plan";
import {
  DYNAMIC_COMMAND_EXIT,
  dynamicRunnerCommandErrorExit,
  dynamicRunnerContextEffect,
  runScopedDynamicRunnerCommand,
} from "./dynamic-command";
import type { DynamicRunnerPersistence, ResolveDynamicRunnerPersistence } from "./dynamic-command";
import { runnerTaskTextEffect } from "./run";

const PRE_SCHEDULE_NODE_IDS = ["pre-research", "pre-planning", "pre-generate-schedule"] as const;

const PRE_SCHEDULE_PHASES = ["generate-schedule", "pre-planning", "pre-research"] as const;

export type PreSchedulePhase = (typeof PRE_SCHEDULE_PHASES)[number];
export type PreScheduleNodeId = (typeof PRE_SCHEDULE_NODE_IDS)[number];

type PhaseNodeIdMap = Readonly<Record<PreSchedulePhase, PreScheduleNodeId>>;

const PHASE_NODE_IDS: PhaseNodeIdMap = {
  "generate-schedule": "pre-generate-schedule",
  "pre-planning": "pre-planning",
  "pre-research": "pre-research",
};

const PHASE_PROFILES = {
  "pre-planning": "moka-ticket-scoper",
  "pre-research": "moka-researcher",
} as const;

const MAX_DYNAMIC_SCHEDULE_WAVES = 90;
const JSON_CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu;

const researchOutputSchema = struct({
  ac: mutableArray(Schema.String),
  files: Schema.optional(mutableArray(Schema.String)),
  findings: mutableArray(Schema.String),
  risks: Schema.optional(mutableArray(Schema.String)),
  target: Schema.optional(Schema.String),
});

type PreScheduleExecutor = (
  plan: ReturnType<typeof createRunnerLaunchPlan>,
  options: Parameters<typeof runLaunchPlan>[1],
) => AgentResult | Promise<AgentResult>;

const preScheduleExecutor = Schema.declare<PreScheduleExecutor>(
  (value): value is PreScheduleExecutor => typeof value === "function",
);
const resolveDynamicRunnerPersistence = Schema.declare<ResolveDynamicRunnerPersistence>(
  (value): value is ResolveDynamicRunnerPersistence => typeof value === "function",
);
const outputStream = Schema.declare<OutputStream>(isOutputStream);

const preScheduleOptionsSchema = struct({
  cwd: Schema.optional(requiredString),
  executor: Schema.optional(preScheduleExecutor),
  payloadFile: requiredString,
  phase: Schema.Literals(PRE_SCHEDULE_PHASES),
  resolvePersistence: Schema.optional(resolveDynamicRunnerPersistence),
  stderr: Schema.optional(outputStream),
  stdout: Schema.optional(outputStream),
});

export type PreScheduleOptions = typeof preScheduleOptionsSchema.Encoded;
type ParsedPreScheduleOptions = typeof preScheduleOptionsSchema.Type;

interface PreScheduleContext {
  config: PipelineConfig;
  payload: RunnerCommandPayload;
  persistence: DynamicRunnerPersistence;
  task: string;
  worktreePath: string;
}

export const preScheduleNodeIds = (): readonly PreScheduleNodeId[] => PRE_SCHEDULE_NODE_IDS;

const ensurePreScheduleRunRecordEffect = (context: PreScheduleContext): Effect.Effect<void, unknown> =>
  context.persistence.runControlStore
    .createRun({
      effort: "normal",
      mode: "write",
      nodeIds: [...preScheduleNodeIds()],
      runId: context.payload.run.id,
      target: "remote",
    })
    .pipe(Effect.asVoid);

const preScheduleContextEffect = (
  options: ParsedPreScheduleOptions,
): Effect.Effect<PreScheduleContext, unknown, RunnerCommandIoService | Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const { config, payload, persistence, worktreePath } = yield* dynamicRunnerContextEffect(options);
    const task = yield* runnerTaskTextEffect(payload.task, worktreePath);
    return { config, payload, persistence, task, worktreePath };
  });

const schedulePhaseContextEffect = (context: PreScheduleContext): Effect.Effect<SchedulePhaseContext, unknown> =>
  Effect.gen(function* effectBody() {
    const research = context.persistence.durableStore.get(context.payload.run.id, "pre-research");
    const ticketPlan = context.persistence.durableStore.get(context.payload.run.id, "pre-planning");
    return {
      research: Option.isSome(research)
        ? yield* Effect.try({
            catch: (error) => error,
            try: () => parseStrictWithSchema(researchOutputSchema, JSON.parse(research.value.result.output)),
          })
        : undefined,
      ticketPlan: Option.isSome(ticketPlan)
        ? parseStrictWithSchema(ticketPlanSchema, JSON.parse(ticketPlan.value.result.output))
        : undefined,
    };
  });

const recordPhaseResultEffect = (
  context: PreScheduleContext,
  result: RuntimeNodeResult,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* effectBody() {
    recordNodeResult({
      result,
      runId: context.payload.run.id,
      store: context.persistence.durableStore,
    });
    yield* context.persistence.runControlStore.updateNodeStatus({
      at: new Date().toISOString(),
      nodeId: result.nodeId,
      runId: context.payload.run.id,
      status: result.status,
    });
  });

const profileInstructionsEffect = (
  worktreePath: string,
  instructions: Option.Option<PipelineConfig["profiles"][string]["instructions"]>,
): Effect.Effect<string, unknown> =>
  Option.match(instructions, {
    onNone: () => Effect.succeed(""),
    onSome: (value) => {
      if (value.inline !== undefined && value.inline.length > 0) {
        return Effect.succeed(value.inline);
      }
      if (value.path === undefined || value.path.length === 0) {
        return Effect.succeed("");
      }
      const instructionPath = value.path;
      return Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await readFile(resolveFileReference(worktreePath, instructionPath), {
            encoding: "utf-8",
          }),
      });
    },
  });

const remotePhaseContract = (label: string, profileInstructions: string): string[] => [
  `Automated remote pre-schedule ${label} phase.`,
  "The phase contract below overrides any conflicting profile instruction.",
  "",
  "Phase contract:",
  "- Do not edit files.",
  "- Do not spawn subagents or delegate to task tools.",
  "- Do not call goal or plan tools.",
  "- Keep inspection bounded to files directly relevant to this task.",
  "- Return exactly one JSON object with no Markdown fences and no prose.",
  "",
  "Profile instructions:",
  profileInstructions.trim() || "(none)",
  "",
];

const agentPhasePrompt = (
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  context: PreScheduleContext,
  profileInstructions: string,
): string => {
  if (phase === "pre-research") {
    return [
      ...remotePhaseContract("research", profileInstructions),
      "Research this task before scheduling.",
      "Return only JSON matching .pipeline/schemas/research.schema.json.",
      "",
      "Task:",
      context.task,
    ].join("\n");
  }
  const research = context.persistence.durableStore.get(context.payload.run.id, "pre-research");
  return [
    ...remotePhaseContract("ticket scoping", profileInstructions),
    "Scope this task into an implementation-ready ticket plan before scheduling.",
    "Return only JSON matching .pipeline/schemas/ticket-plan.schema.json.",
    "",
    "Task:",
    context.task,
    "",
    "Research:",
    Option.isSome(research) ? research.value.result.output : "No pre-research output recorded.",
  ].join("\n");
};

const agentPhasePromptEffect = (
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  context: PreScheduleContext,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    const profileId = PHASE_PROFILES[phase];
    const profile = context.config.profiles[profileId];
    const profileInstructions = yield* profileInstructionsEffect(
      context.worktreePath,
      Option.fromNullishOr(profile.instructions),
    );
    return agentPhasePrompt(phase, context, profileInstructions);
  });

const jsonObjectCandidates = (output: string): string[] => {
  const trimmed = output.trim();
  const candidates = new Set<string>();
  if (trimmed.length > 0) {
    candidates.add(trimmed);
  }
  const fenced = JSON_CODE_FENCE_RE.exec(trimmed)?.[1];
  if (fenced !== undefined && fenced.trim().length > 0) {
    candidates.add(fenced.trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return [...candidates];
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const parseJsonObjectOutput = (output: string): unknown => {
  const errors: string[] = [];
  for (const candidate of jsonObjectCandidates(output)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  throw new Error(errors.at(-1) ?? "no JSON object candidate found");
};

const outputExcerpt = (output: string): string => output.trim().replaceAll(/\s+/gu, " ").slice(0, 500);

const phaseSchemaError = (
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  schemaName: string,
  error: Error,
  output: string,
): Error =>
  new Error(
    `${phase} returned JSON that does not match ${schemaName}: ${error.message}. Output excerpt: ${outputExcerpt(output)}`,
  );

const validatedAgentPhaseOutputEffect = (
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  output: string,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* effectBody() {
    const json = yield* Effect.try({
      catch: (error) =>
        new Error(`${phase} returned invalid JSON: ${errorMessage(error)}. Output excerpt: ${outputExcerpt(output)}`),
      try: () => parseJsonObjectOutput(output),
    });
    if (phase === "pre-research") {
      const parsed = parseResultWithSchema(researchOutputSchema, json, {
        onExcessProperty: "error",
      });
      if (!parsed.ok) {
        return yield* Effect.fail(phaseSchemaError(phase, "research.schema.json", parsed.error, output));
      }
      return JSON.stringify(parsed.value);
    }
    const parsed = parseResultWithSchema(ticketPlanSchema, json, {
      onExcessProperty: "error",
    });
    if (!parsed.ok) {
      return yield* Effect.fail(phaseSchemaError(phase, "ticket-plan.schema.json", parsed.error, output));
    }
    return JSON.stringify(parsed.value);
  });

const runAgentPhaseEffect = (
  options: ParsedPreScheduleOptions,
  context: PreScheduleContext,
): Effect.Effect<RuntimeNodeResult, unknown> => {
  const { phase } = options;
  if (phase === "generate-schedule") {
    return Effect.fail(new Error("generate-schedule is not an agent phase."));
  }
  return Effect.gen(function* effectBody() {
    const plan = createRunnerLaunchPlan(context.config, {
      nodeId: PHASE_NODE_IDS[phase],
      profileId: PHASE_PROFILES[phase],
      prompt: yield* agentPhasePromptEffect(phase, context),
      worktreePath: context.worktreePath,
    });
    const executor = options.executor ?? runLaunchPlan;
    const agentResult = yield* Effect.tryPromise({
      catch: (error) => error,
      try: async () => await executor(plan, {}),
    });
    const normalized = normalizeRunnerOutput(plan, agentResult.stdout);
    const output =
      agentResult.exitCode === 0 ? yield* validatedAgentPhaseOutputEffect(phase, normalized.output) : normalized.output;
    if (phase === "pre-planning" && agentResult.exitCode === 0) {
      yield* parseTicketPlanEffect(output);
    }
    if (phase === "pre-research" && agentResult.exitCode === 0) {
      yield* Effect.try({
        catch: (error) => error,
        try: () => parseStrictWithSchema(researchOutputSchema, JSON.parse(output)),
      });
    }
    return {
      attempts: 1,
      evidence: normalized.evidence,
      exitCode: agentResult.exitCode,
      nodeId: PHASE_NODE_IDS[phase],
      output,
      status: agentResult.exitCode === 0 ? "passed" : "failed",
    };
  });
};

const scheduleEntrypointId = (payload: RunnerCommandPayload): string => {
  if (payload.submission.kind !== "graph") {
    throw new Error("Pre-schedule generation requires a graph submission.");
  }
  return payload.submission.mode === "quick" ? "quick" : "execute";
};

const generateSchedulePhaseEffect = (context: PreScheduleContext): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
    const phaseContext = yield* schedulePhaseContextEffect(context);
    const entrypointId = scheduleEntrypointId(context.payload);
    const generated = yield* Effect.tryPromise({
      catch: (error) => error,
      try: async () =>
        await generateScheduleArtifactInMemory({
          config: context.config,
          entrypointId,
          phaseContext,
          pullRequestDeliveryRequested: context.payload.delivery.pullRequest,
          runId: context.payload.run.id,
          task: context.task,
          worktreePath: context.worktreePath,
        }),
    });
    const compiled = yield* Effect.try({
      catch: (error) => error,
      try: () => compileScheduleArtifact(context.config, generated.artifact, context.worktreePath),
    });
    if (compiled.plan.parallelBatches.length > MAX_DYNAMIC_SCHEDULE_WAVES) {
      return yield* Effect.fail(
        new Error(
          `Generated schedule has ${compiled.plan.parallelBatches.length} topological waves; dynamic Argo recursion supports at most ${MAX_DYNAMIC_SCHEDULE_WAVES}.`,
        ),
      );
    }
    yield* context.persistence.runControlStore.publishSchedule({
      nodeIds: compiled.plan.topologicalOrder.map((node) => node.id),
      runId: context.payload.run.id,
      schedule: generated.yaml,
    });
    return {
      attempts: 1,
      evidence: [
        `published schedule ${generated.artifact.schedule_id} with ${compiled.plan.topologicalOrder.length} nodes`,
      ],
      exitCode: 0,
      nodeId: PHASE_NODE_IDS["generate-schedule"],
      output: generated.yaml,
      status: "passed",
    };
  });

const runPreSchedulePhaseEffect = (
  options: ParsedPreScheduleOptions,
): Effect.Effect<number, never, RunnerCommandIoService | Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const context = yield* preScheduleContextEffect(options);
    yield* ensurePreScheduleRunRecordEffect(context);
    const result =
      options.phase === "generate-schedule"
        ? yield* generateSchedulePhaseEffect(context)
        : yield* runAgentPhaseEffect(options, context);
    yield* recordPhaseResultEffect(context, result);
    return result.status === "passed" ? DYNAMIC_COMMAND_EXIT.pass : DYNAMIC_COMMAND_EXIT.fail;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => dynamicRunnerCommandErrorExit(error, Option.fromNullishOr(options.stderr))),
    ),
  );

export const runPreSchedulePhase = async (rawOptions: Partial<PreScheduleOptions> = {}): Promise<number> =>
  await runScopedDynamicRunnerCommand(preScheduleOptionsSchema, rawOptions, runPreSchedulePhaseEffect);
