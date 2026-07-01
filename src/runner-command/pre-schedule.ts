import { readFile } from "node:fs/promises";
import { Effect, type Scope } from "effect";
import { z } from "zod";
import type { PipelineConfig } from "../config";
import { resolveFileReference } from "../path-refs";
import {
  compileScheduleArtifact,
  generateScheduleArtifactInMemory,
  type SchedulePhaseContext,
} from "../planning/generate";
import { type AgentResult, createRunnerLaunchPlan } from "../runner";
import { runLaunchPlan } from "../runner/subprocess";
import type { RunnerCommandPayload } from "../runner-command-contract";
import { normalizeRunnerOutput } from "../runner-output";
import type { RuntimeNodeResult } from "../runtime/contracts";
import {
  isOutputStream,
  type OutputStream,
  type RunnerCommandIoService,
} from "../runtime/services/runner-command-io-service";
import { recordNodeResult } from "../runtime/step/step-node";
import {
  parseTicketPlanEffect,
  ticketPlanSchema,
} from "../tickets/ticket-plan";
import {
  DYNAMIC_COMMAND_EXIT,
  type DynamicRunnerPersistence,
  dynamicRunnerCommandErrorExit,
  dynamicRunnerContextEffect,
  type ResolveDynamicRunnerPersistence,
  runScopedDynamicRunnerCommand,
} from "./dynamic-command";
import { runnerTaskTextEffect } from "./run";

const PRE_SCHEDULE_NODE_IDS = [
  "pre-research",
  "pre-planning",
  "pre-generate-schedule",
] as const;

const PRE_SCHEDULE_PHASES = [
  "generate-schedule",
  "pre-planning",
  "pre-research",
] as const;

export type PreSchedulePhase = (typeof PRE_SCHEDULE_PHASES)[number];
export type PreScheduleNodeId = (typeof PRE_SCHEDULE_NODE_IDS)[number];

type PhaseNodeIdMap = {
  readonly [K in PreSchedulePhase]: PreScheduleNodeId;
};

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
const JSON_CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

const researchOutputSchema = z
  .object({
    ac: z.array(z.string()),
    files: z.array(z.string()).optional(),
    findings: z.array(z.string()),
    risks: z.array(z.string()).optional(),
    target: z.string().optional(),
  })
  .strict();

type PreScheduleExecutor = (
  plan: ReturnType<typeof createRunnerLaunchPlan>,
  options: Parameters<typeof runLaunchPlan>[1]
) => AgentResult | Promise<AgentResult>;

const preScheduleOptionsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    executor: z
      .custom<PreScheduleExecutor>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    phase: z.enum(PRE_SCHEDULE_PHASES),
    resolvePersistence: z
      .custom<ResolveDynamicRunnerPersistence>(
        (value) => typeof value === "function"
      )
      .optional(),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    stdout: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
  })
  .strict();

export type PreScheduleOptions = z.input<typeof preScheduleOptionsSchema>;

interface PreScheduleContext {
  config: PipelineConfig;
  payload: RunnerCommandPayload;
  persistence: DynamicRunnerPersistence;
  task: string;
  worktreePath: string;
}

export function preScheduleNodeIds(): readonly PreScheduleNodeId[] {
  return PRE_SCHEDULE_NODE_IDS;
}

export function runPreSchedulePhase(
  rawOptions: Partial<PreScheduleOptions> = {}
): Promise<number> {
  return runScopedDynamicRunnerCommand(
    preScheduleOptionsSchema,
    rawOptions,
    runPreSchedulePhaseEffect
  );
}

function runPreSchedulePhaseEffect(
  options: z.output<typeof preScheduleOptionsSchema>
): Effect.Effect<number, never, RunnerCommandIoService | Scope.Scope> {
  return Effect.gen(function* () {
    const context = yield* preScheduleContextEffect(options);
    yield* ensurePreScheduleRunRecordEffect(context);
    const result =
      options.phase === "generate-schedule"
        ? yield* generateSchedulePhaseEffect(context)
        : yield* runAgentPhaseEffect(options, context);
    yield* recordPhaseResultEffect(context, result);
    return result.status === "passed"
      ? DYNAMIC_COMMAND_EXIT.pass
      : DYNAMIC_COMMAND_EXIT.fail;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => dynamicRunnerCommandErrorExit(error, options.stderr))
    )
  );
}

function ensurePreScheduleRunRecordEffect(
  context: PreScheduleContext
): Effect.Effect<void, unknown> {
  return context.persistence.runControlStore
    .createRun({
      effort: "normal",
      mode: "write",
      nodeIds: [...preScheduleNodeIds()],
      runId: context.payload.run.id,
      target: "remote",
    })
    .pipe(Effect.asVoid);
}

function preScheduleContextEffect(
  options: z.output<typeof preScheduleOptionsSchema>
): Effect.Effect<
  PreScheduleContext,
  unknown,
  RunnerCommandIoService | Scope.Scope
> {
  return Effect.gen(function* () {
    const { config, payload, persistence, worktreePath } =
      yield* dynamicRunnerContextEffect(options);
    const task = yield* runnerTaskTextEffect(payload.task, worktreePath);
    return { config, payload, persistence, task, worktreePath };
  });
}

function runAgentPhaseEffect(
  options: z.output<typeof preScheduleOptionsSchema>,
  context: PreScheduleContext
): Effect.Effect<RuntimeNodeResult, unknown> {
  const phase = options.phase;
  if (phase === "generate-schedule") {
    return Effect.fail(new Error("generate-schedule is not an agent phase."));
  }
  return Effect.gen(function* () {
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
      agentResult.exitCode === 0
        ? yield* validatedAgentPhaseOutputEffect(phase, normalized.output)
        : normalized.output;
    if (phase === "pre-planning" && agentResult.exitCode === 0) {
      yield* parseTicketPlanEffect(output);
    }
    if (phase === "pre-research" && agentResult.exitCode === 0) {
      yield* Effect.try({
        catch: (error) => error,
        try: () => researchOutputSchema.parse(JSON.parse(output)),
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
}

function generateSchedulePhaseEffect(
  context: PreScheduleContext
): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    const phaseContext = yield* schedulePhaseContextEffect(context);
    const entrypointId = scheduleEntrypointId(context.payload);
    const generated = yield* Effect.tryPromise({
      catch: (error) => error,
      try: () =>
        generateScheduleArtifactInMemory({
          config: context.config,
          entrypointId,
          phaseContext,
          runId: context.payload.run.id,
          task: context.task,
          worktreePath: context.worktreePath,
        }),
    });
    const compiled = yield* Effect.try({
      catch: (error) => error,
      try: () =>
        compileScheduleArtifact(
          context.config,
          generated.artifact,
          context.worktreePath
        ),
    });
    if (compiled.plan.parallelBatches.length > MAX_DYNAMIC_SCHEDULE_WAVES) {
      return yield* Effect.fail(
        new Error(
          `Generated schedule has ${compiled.plan.parallelBatches.length} topological waves; dynamic Argo recursion supports at most ${MAX_DYNAMIC_SCHEDULE_WAVES}.`
        )
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
}

function schedulePhaseContextEffect(
  context: PreScheduleContext
): Effect.Effect<SchedulePhaseContext, unknown> {
  return Effect.gen(function* () {
    const research = context.persistence.durableStore.get(
      context.payload.run.id,
      "pre-research"
    );
    const ticketPlan = context.persistence.durableStore.get(
      context.payload.run.id,
      "pre-planning"
    );
    return {
      research: research
        ? yield* Effect.try({
            catch: (error) => error,
            try: () =>
              researchOutputSchema.parse(JSON.parse(research.result.output)),
          })
        : undefined,
      ticketPlan: ticketPlan
        ? ticketPlanSchema.parse(JSON.parse(ticketPlan.result.output))
        : undefined,
    };
  });
}

function recordPhaseResultEffect(
  context: PreScheduleContext,
  result: RuntimeNodeResult
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
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
}

function agentPhasePromptEffect(
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  context: PreScheduleContext
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const profileId = PHASE_PROFILES[phase];
    const profile = context.config.profiles[profileId];
    const profileInstructions = yield* profileInstructionsEffect(
      context.worktreePath,
      profile?.instructions
    );
    return agentPhasePrompt(phase, context, profileInstructions);
  });
}

function profileInstructionsEffect(
  worktreePath: string,
  instructions: PipelineConfig["profiles"][string]["instructions"] | undefined
): Effect.Effect<string, unknown> {
  if (!instructions) {
    return Effect.succeed("");
  }
  if (instructions.inline) {
    return Effect.succeed(instructions.inline);
  }
  const instructionPath = instructions.path;
  if (!instructionPath) {
    return Effect.succeed("");
  }
  return Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      readFile(resolveFileReference(worktreePath, instructionPath), {
        encoding: "utf8",
      }),
  });
}

function agentPhasePrompt(
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  context: PreScheduleContext,
  profileInstructions: string
): string {
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
  const research = context.persistence.durableStore.get(
    context.payload.run.id,
    "pre-research"
  );
  return [
    ...remotePhaseContract("ticket scoping", profileInstructions),
    "Scope this task into an implementation-ready ticket plan before scheduling.",
    "Return only JSON matching .pipeline/schemas/ticket-plan.schema.json.",
    "",
    "Task:",
    context.task,
    "",
    "Research:",
    research?.result.output ?? "No pre-research output recorded.",
  ].join("\n");
}

function remotePhaseContract(
  label: string,
  profileInstructions: string
): string[] {
  return [
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
}

function validatedAgentPhaseOutputEffect(
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  output: string
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const json = yield* Effect.try({
      catch: (error) =>
        new Error(
          `${phase} returned invalid JSON: ${errorMessage(error)}. Output excerpt: ${outputExcerpt(output)}`
        ),
      try: () => parseJsonObjectOutput(output),
    });
    if (phase === "pre-research") {
      const parsed = researchOutputSchema.safeParse(json);
      if (!parsed.success) {
        return yield* Effect.fail(
          phaseSchemaError(phase, "research.schema.json", parsed.error, output)
        );
      }
      return JSON.stringify(parsed.data);
    }
    const parsed = ticketPlanSchema.safeParse(json);
    if (!parsed.success) {
      return yield* Effect.fail(
        phaseSchemaError(phase, "ticket-plan.schema.json", parsed.error, output)
      );
    }
    return JSON.stringify(parsed.data);
  });
}

function phaseSchemaError(
  phase: Exclude<PreSchedulePhase, "generate-schedule">,
  schemaName: string,
  error: z.ZodError,
  output: string
): Error {
  return new Error(
    `${phase} returned JSON that does not match ${schemaName}: ${error.message}. Output excerpt: ${outputExcerpt(output)}`
  );
}

function parseJsonObjectOutput(output: string): unknown {
  const errors: string[] = [];
  for (const candidate of jsonObjectCandidates(output)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  throw new Error(errors.at(-1) ?? "no JSON object candidate found");
}

function jsonObjectCandidates(output: string): string[] {
  const trimmed = output.trim();
  const candidates = new Set<string>();
  if (trimmed.length > 0) {
    candidates.add(trimmed);
  }
  const fenced = trimmed.match(JSON_CODE_FENCE_RE)?.[1];
  if (fenced?.trim()) {
    candidates.add(fenced.trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return [...candidates];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputExcerpt(output: string): string {
  return output.trim().replace(/\s+/g, " ").slice(0, 500);
}

function scheduleEntrypointId(payload: RunnerCommandPayload): string {
  if (payload.submission.kind !== "graph") {
    throw new Error("Pre-schedule generation requires a graph submission.");
  }
  return payload.submission.mode === "quick" ? "quick" : "execute";
}
