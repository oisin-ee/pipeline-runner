import { Data } from "effect";
import type { PipelineConfig, RunnerType } from "./config";
import {
  agentIdleTimeoutMsFromEnv,
  agentTimeoutMsFromEnv,
} from "./runner/timeouts";

export type Harness = "opencode";
export type AgentRole =
  | "researcher"
  | "test-writer"
  | "code-writer"
  | "verifier";

/**
 * Agent-output boundary, layer 1 of 4 (PIPE-74 B3). `AgentResult` is the RAW
 * terminal result of one runner subprocess/session: exit code, accumulated
 * stdout/stderr, and execution metadata.
 */
export interface AgentResult {
  argv?: string[];
  exitCode: number;
  /** opencode session id when driven through the SDK executor (PIPE-73). */
  sessionId?: string;
  stderr?: string;
  stdout: string;
  timedOut?: boolean;
}

/**
 * Agent-output boundary, layer 2 of 4 (PIPE-74 B3). A single incremental chunk
 * of a runner's live output stream, surfaced while the subprocess is running.
 */
export interface RunnerOutputEvent {
  chunk: string;
  nodeId: string;
  stream: "stderr" | "stdout";
}

/**
 * Lowest layer of the runtime-options stack (PIPE-74 B3): the per-invocation
 * controls a runner executor needs -- cancellation and live-output streaming.
 */
export interface RunnerExecutionOptions {
  onOutput?: (event: RunnerOutputEvent) => void;
  signal?: AbortSignal;
}

export interface AgentRunRequest {
  contextFile: string | null;
  harness: Harness;
  prompt: string;
  role: AgentRole;
  /** Optional ticket id reserved for YAML-driven adapters in the v1 runtime. */
  ticketId?: string | null;
  worktreePath: string;
}

export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentResult>;
}

export type ReasoningEffort = NonNullable<
  PipelineConfig["profiles"][string]["reasoning_effort"]
>;

export type ProfileConfig = PipelineConfig["profiles"][string];
export type ActorConfig = ProfileConfig;

export interface RunnerLaunchPlan {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  idleTimeoutMs?: number;
  model?: string;
  nodeId: string;
  outputFormat: string;
  profileId?: string;
  /**
   * PIPE-90.12: glob patterns (from the profile's `filesystem.protected`) the
   * executing agent must not modify. Snapshotted before launch and reverted
   * afterwards by runLaunchPlan.
   */
  protectedPaths?: readonly string[];
  runnerId: string;
  timeoutMs?: number;
  type: RunnerType;
  variant?: ReasoningEffort;
}

export interface RunnerLaunchInput {
  contextFile?: string | null;
  model?: string;
  nodeId: string;
  profileId?: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
  worktreePath: string;
}

type RunnerOutputFormat = NonNullable<
  PipelineConfig["runners"][string]["capabilities"]["output_formats"]
>[number];

export class RunnerCapabilityError extends Data.TaggedError(
  "RunnerCapabilityError"
)<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

interface NativeArgOptions {
  actor?: ActorConfig;
  model?: string;
  runner?: PipelineConfig["runners"][string];
  variant?: ReasoningEffort;
}

export function createRunnerLaunchPlan(
  config: PipelineConfig,
  input: RunnerLaunchInput
): RunnerLaunchPlan {
  const profile = runnerProfile(config, input.profileId);
  return createActorLaunchPlan(config, input, profile, runnerIdFor(profile));
}

export function createOrchestratorLaunchPlan(
  config: PipelineConfig,
  input: Omit<RunnerLaunchInput, "profileId">
): RunnerLaunchPlan {
  if (!config.orchestrator) {
    throw new RunnerCapabilityError("orchestrator profile is not configured");
  }
  return createActorLaunchPlan(
    config,
    {
      ...input,
      profileId: config.orchestrator.profile,
    },
    config.profiles[config.orchestrator.profile],
    config.profiles[config.orchestrator.profile]?.runner ?? "command"
  );
}

function createActorLaunchPlan(
  config: PipelineConfig,
  input: RunnerLaunchInput,
  actor: ActorConfig | undefined,
  runnerId: string
): RunnerLaunchPlan {
  const runner = declaredRunner(config, runnerId);
  const command = runner.command ?? runner.type;
  const base = runnerLaunchBase(input, actor, runner, runnerId);

  if (runner.type === "command") {
    return {
      ...base,
      args: commandRunnerArgs(runner, runnerId, input),
      command,
    };
  }

  return {
    ...base,
    args: harnessArgv(
      input.prompt,
      input.worktreePath,
      input.contextFile ?? null,
      {
        actor,
        model: input.model,
        runner,
        variant: base.variant,
      }
    ),
    command,
  };
}

function runnerProfile(
  config: PipelineConfig,
  profileId: string | undefined
): ActorConfig | undefined {
  if (!profileId) {
    return;
  }
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new RunnerCapabilityError(`profile '${profileId}' is not declared`);
  }
  return profile;
}

function runnerIdFor(actor: ActorConfig | undefined): string {
  return actor?.runner ?? "command";
}

function declaredRunner(
  config: PipelineConfig,
  runnerId: string
): PipelineConfig["runners"][string] {
  const runner = config.runners[runnerId];
  if (!runner) {
    throw new RunnerCapabilityError(`runner '${runnerId}' is not declared`);
  }
  return runner;
}

function runnerLaunchBase(
  input: RunnerLaunchInput,
  actor: ActorConfig | undefined,
  runner: PipelineConfig["runners"][string],
  runnerId: string
) {
  const { model, variant } = resolveLaunchModel(input, actor, runner);
  return {
    cwd: input.worktreePath,
    env: {},
    idleTimeoutMs: agentIdleTimeoutMsFromEnv(),
    model,
    nodeId: input.nodeId,
    outputFormat: resolveOutputFormat(actor, runner, runnerId),
    profileId: input.profileId,
    ...protectedPathsField(actor),
    runnerId,
    timeoutMs: actor?.timeout_ms ?? agentTimeoutMsFromEnv(),
    type: runner.type,
    variant,
  };
}

function resolveOutputFormat(
  actor: ActorConfig | undefined,
  runner: PipelineConfig["runners"][string],
  runnerId: string
): string {
  const outputFormat = actorOutputFormat(actor);
  if (!runnerSupportsOutputFormat(runner, outputFormat)) {
    throw new RunnerCapabilityError(
      `runner '${runnerId}' does not support output format '${outputFormat}'`
    );
  }
  return outputFormat;
}

function actorOutputFormat(actor: ActorConfig | undefined): RunnerOutputFormat {
  return actor?.output?.format ?? "text";
}

function runnerSupportsOutputFormat(
  runner: PipelineConfig["runners"][string],
  outputFormat: RunnerOutputFormat
): boolean {
  return (
    !runner.capabilities.output_formats ||
    runner.capabilities.output_formats.includes(outputFormat)
  );
}

function commandRunnerArgs(
  runner: PipelineConfig["runners"][string],
  runnerId: string,
  input: RunnerLaunchInput
): string[] {
  if (!runner.command) {
    throw new RunnerCapabilityError(
      `command runner '${runnerId}' must declare command`
    );
  }
  return renderArgv(runner.args ?? [], input.prompt, input.worktreePath);
}

export function harnessArgv(
  prompt: string,
  worktreePath: string,
  contextFile: string | null,
  options: NativeArgOptions = {}
): string[] {
  const skillArgs = skillArgsFor();
  return contextFile
    ? [
        "run",
        "--format",
        "json",
        ...optionalModelArgs(options.runner, options.actor, options.model),
        ...optionalVariantArgs(options.variant),
        ...skillArgs,
        "--dangerously-skip-permissions",
        "--dir",
        worktreePath,
        prompt,
        "--file",
        contextFile,
      ]
    : [
        "run",
        "--format",
        "json",
        ...optionalModelArgs(options.runner, options.actor, options.model),
        ...optionalVariantArgs(options.variant),
        ...skillArgs,
        "--dangerously-skip-permissions",
        "--dir",
        worktreePath,
        prompt,
      ];
}

function optionalModelArgs(
  runner?: PipelineConfig["runners"][string],
  actor?: ActorConfig,
  selectedModel?: string
): string[] {
  const model = resolveOpencodeModel(runner, actor, selectedModel);
  return model ? ["--model", model] : [];
}

function resolveOpencodeModel(
  runner?: PipelineConfig["runners"][string],
  actor?: ActorConfig,
  selectedModel?: string
): string | undefined {
  return firstDefinedModel([
    selectedModel,
    actorModel(actor),
    runnerModel(runner),
  ]);
}

function firstDefinedModel(
  values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined);
}

function actorModel(actor?: ActorConfig): string | undefined {
  return actor?.model;
}

function runnerModel(
  runner?: PipelineConfig["runners"][string]
): string | undefined {
  return runner?.model;
}

function optionalVariantArgs(variant?: ReasoningEffort): string[] {
  return variant ? ["--variant", variant] : [];
}

function resolveVariant(
  effort: ReasoningEffort | undefined,
  model: string | undefined
): ReasoningEffort | undefined {
  if (!(effort && model)) {
    return;
  }
  return model.startsWith("openai/") || model.startsWith("broker/")
    ? effort
    : undefined;
}

function resolveLaunchModel(
  input: RunnerLaunchInput,
  actor: ActorConfig | undefined,
  runner: PipelineConfig["runners"][string]
): { model: string | undefined; variant: ReasoningEffort | undefined } {
  const model = firstDefinedModel([input.model, actor?.model, runner.model]);
  const effort = firstDefinedEffort([
    input.reasoningEffort,
    actor?.reasoning_effort,
    runner.reasoning_effort,
  ]);
  return { model, variant: resolveVariant(effort, model) };
}

function firstDefinedEffort(
  values: Array<ReasoningEffort | undefined>
): ReasoningEffort | undefined {
  return values.find((value) => value !== undefined);
}

function protectedPathsField(actor: ActorConfig | undefined): {
  protectedPaths?: readonly string[];
} {
  const protectedPaths = actor?.filesystem?.protected;
  return protectedPaths && protectedPaths.length > 0 ? { protectedPaths } : {};
}

function skillArgsFor(): string[] {
  return [];
}

function renderArgv(args: string[], prompt: string, cwd: string): string[] {
  return args.map((arg) =>
    arg.replaceAll("{{prompt}}", prompt).replaceAll("{{cwd}}", cwd)
  );
}
