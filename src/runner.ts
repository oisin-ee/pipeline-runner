import { Data } from "effect";
import {
  firstSomeOf,
  fromNullishOr,
  getOrUndefined,
  match as matchOption,
  none,
} from "effect/Option";
import type { Option } from "effect/Option";

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

const NO_CONTEXT_FILE = null;

type NoContextFile = typeof NO_CONTEXT_FILE;
type ContextFileInput = string | NoContextFile;
type EnvironmentValue = NodeJS.ProcessEnv[string];

/**
 * Agent-output boundary, layer 1 of 4 (PIPE-74 B3). `AgentResult` is the RAW
 * terminal result of one runner subprocess/session: exit code, accumulated
 * stdout/stderr, and execution metadata.
 */
interface AgentResultRequiredFields {
  exitCode: number;
  stdout: string;
}

interface AgentResultOptionalFields {
  argv: string[];
  /** opencode session id when driven through the SDK executor (PIPE-73). */
  sessionId: string;
  stderr: string;
  timedOut: boolean;
}

export type AgentResult = AgentResultRequiredFields &
  Partial<AgentResultOptionalFields>;

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
interface RunnerExecutionOptionFields {
  onOutput: (event: RunnerOutputEvent) => void;
  signal: AbortSignal;
}

export type RunnerExecutionOptions = Partial<RunnerExecutionOptionFields>;

interface AgentRunRequestRequiredFields {
  contextFile: ContextFileInput;
  harness: Harness;
  prompt: string;
  role: AgentRole;
  worktreePath: string;
}

interface AgentRunRequestOptionalFields {
  /** Optional ticket id reserved for YAML-driven adapters in the v1 runtime. */
  ticketId: ContextFileInput;
}

export type AgentRunRequest = AgentRunRequestRequiredFields &
  Partial<AgentRunRequestOptionalFields>;

export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentResult>;
}

export type ReasoningEffort = NonNullable<
  PipelineConfig["profiles"][string]["reasoning_effort"]
>;

export type ProfileConfig = PipelineConfig["profiles"][string];
export type ActorConfig = ProfileConfig;

interface RunnerLaunchPlanRequiredFields {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, EnvironmentValue>;
  nodeId: string;
  outputFormat: string;
  runnerId: string;
  type: RunnerType;
}

interface RunnerLaunchPlanOptionalFields {
  idleTimeoutMs: number;
  model: string;
  profileId: string;
  /**
   * PIPE-90.12: glob patterns (from the profile's `filesystem.protected`) the
   * executing agent must not modify. Snapshotted before launch and reverted
   * afterwards by runLaunchPlan.
   */
  protectedPaths: readonly string[];
  timeoutMs: number;
  variant: ReasoningEffort;
}

export type RunnerLaunchPlan = RunnerLaunchPlanRequiredFields &
  Partial<RunnerLaunchPlanOptionalFields>;

interface RunnerLaunchInputRequiredFields {
  nodeId: string;
  prompt: string;
  worktreePath: string;
}

interface RunnerLaunchInputOptionalFields {
  contextFile: ContextFileInput;
  model: string;
  profileId: string;
  reasoningEffort: ReasoningEffort;
}

export type RunnerLaunchInput = RunnerLaunchInputRequiredFields &
  Partial<RunnerLaunchInputOptionalFields>;

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

interface NativeArgOptionFields {
  actor: ActorConfig;
  model: string;
  runner: PipelineConfig["runners"][string];
  variant: ReasoningEffort;
}

type NativeArgOptions = Partial<NativeArgOptionFields>;

const optionField = <A, B>(
  option: Option<A>,
  select: (value: A) => B
): Option<NonNullable<B>> =>
  matchOption(option, {
    onNone: () => none(),
    onSome: (value) => fromNullishOr(select(value)),
  });

const optionalInputField = <B>(
  input: Partial<RunnerLaunchInputOptionalFields>,
  select: (value: Partial<RunnerLaunchInputOptionalFields>) => B
): Option<NonNullable<B>> => fromNullishOr(select(input));

const runnerProfile = (
  config: PipelineConfig,
  profileId: Option<string>
): Option<ActorConfig> =>
  matchOption(profileId, {
    onNone: () => none(),
    onSome: (id) => {
      if (!Object.hasOwn(config.profiles, id)) {
        throw new RunnerCapabilityError(`profile '${id}' is not declared`);
      }
      return fromNullishOr(config.profiles[id]);
    },
  });

const runnerIdFor = (actor: Option<ActorConfig>): string =>
  matchOption(actor, {
    onNone: () => "command",
    onSome: (value) => value.runner,
  });

const optionalStringArgs = (flag: string, value: Option<string>): string[] =>
  matchOption(value, {
    onNone: () => [],
    onSome: (definedValue) => [flag, definedValue],
  });

const optionalVariantArgs = (variant: Option<ReasoningEffort>): string[] =>
  optionalStringArgs("--variant", variant);

const optionalIdleTimeoutField = (
  value: Option<number>
): Partial<Pick<RunnerLaunchPlanOptionalFields, "idleTimeoutMs">> =>
  matchOption(value, {
    onNone: () => ({}),
    onSome: (idleTimeoutMs) => ({ idleTimeoutMs }),
  });

const optionalModelField = (
  value: Option<string>
): Partial<Pick<RunnerLaunchPlanOptionalFields, "model">> =>
  matchOption(value, {
    onNone: () => ({}),
    onSome: (model) => ({ model }),
  });

const optionalProfileIdField = (
  value: Option<string>
): Partial<Pick<RunnerLaunchPlanOptionalFields, "profileId">> =>
  matchOption(value, {
    onNone: () => ({}),
    onSome: (profileId) => ({ profileId }),
  });

const optionalTimeoutField = (
  value: Option<number>
): Partial<Pick<RunnerLaunchPlanOptionalFields, "timeoutMs">> =>
  matchOption(value, {
    onNone: () => ({}),
    onSome: (timeoutMs) => ({ timeoutMs }),
  });

const optionalVariantField = (
  value: Option<ReasoningEffort>
): Partial<Pick<RunnerLaunchPlanOptionalFields, "variant">> =>
  matchOption(value, {
    onNone: () => ({}),
    onSome: (variant) => ({ variant }),
  });

const optionalProtectedPathsField = (
  actor: Option<ActorConfig>
): Partial<Pick<RunnerLaunchPlanOptionalFields, "protectedPaths">> => {
  const protectedPaths = optionField(
    actor,
    (value) => value.filesystem?.protected
  );
  return matchOption(protectedPaths, {
    onNone: () => ({}),
    onSome: (paths) => (paths.length > 0 ? { protectedPaths: paths } : {}),
  });
};

const optionalContextFile = (
  input: Partial<RunnerLaunchInputOptionalFields>
): Option<string> => optionalInputField(input, (value) => value.contextFile);

const optionalProfileId = (
  input: Partial<RunnerLaunchInputOptionalFields>
): Option<string> => optionalInputField(input, (value) => value.profileId);

const optionalInputModel = (
  input: Partial<RunnerLaunchInputOptionalFields>
): Option<string> => optionalInputField(input, (value) => value.model);

const optionalInputReasoningEffort = (
  input: Partial<RunnerLaunchInputOptionalFields>
): Option<ReasoningEffort> =>
  optionalInputField(input, (value) => value.reasoningEffort);

const optionalActorModel = (actor: Option<ActorConfig>): Option<string> =>
  optionField(actor, (value) => value.model);

const optionalRunnerModel = (
  runner: Option<PipelineConfig["runners"][string]>
): Option<string> => optionField(runner, (value) => value.model);

const optionalActorEffort = (
  actor: Option<ActorConfig>
): Option<ReasoningEffort> =>
  optionField(actor, (value) => value.reasoning_effort);

const optionalRunnerEffort = (
  runner: Option<PipelineConfig["runners"][string]>
): Option<ReasoningEffort> =>
  optionField(runner, (value) => value.reasoning_effort);

const optionalActorTimeout = (actor: Option<ActorConfig>): Option<number> =>
  optionField(actor, (value) => value.timeout_ms);

const optionalActorOutputFormat = (
  actor: Option<ActorConfig>
): Option<RunnerOutputFormat> =>
  optionField(actor, (value) => value.output?.format);

const actorOutputFormat = (actor: Option<ActorConfig>): RunnerOutputFormat =>
  matchOption(optionalActorOutputFormat(actor), {
    onNone: () => "text",
    onSome: (format) => format,
  });

const optionalRunner = (
  runner: PipelineConfig["runners"][string]
): Option<PipelineConfig["runners"][string]> => fromNullishOr(runner);

const resolveOpencodeModel = (
  runner: Option<PipelineConfig["runners"][string]>,
  actor: Option<ActorConfig>,
  selectedModel: Option<string>
): Option<string> =>
  firstSomeOf([
    selectedModel,
    optionalActorModel(actor),
    optionalRunnerModel(runner),
  ]);

const optionalModelArgs = (
  runner: Option<PipelineConfig["runners"][string]>,
  actor: Option<ActorConfig>,
  selectedModel: Option<string>
): string[] =>
  optionalStringArgs(
    "--model",
    resolveOpencodeModel(runner, actor, selectedModel)
  );

const isVariantModel = (model: string): boolean =>
  model.startsWith("openai/") || model.startsWith("broker/");

const resolveVariant = (
  effort: Option<ReasoningEffort>,
  model: Option<string>
): Option<ReasoningEffort> =>
  matchOption(model, {
    onNone: () => none(),
    onSome: (value) => (isVariantModel(value) ? effort : none()),
  });

const runnerSupportsOutputFormat = (
  runner: PipelineConfig["runners"][string],
  outputFormat: RunnerOutputFormat
): boolean =>
  matchOption(fromNullishOr(runner.capabilities.output_formats), {
    onNone: () => true,
    onSome: (formats) => formats.includes(outputFormat),
  });

const resolveOutputFormat = (
  actor: Option<ActorConfig>,
  runner: PipelineConfig["runners"][string],
  runnerId: string
): string => {
  const outputFormat = actorOutputFormat(actor);
  if (!runnerSupportsOutputFormat(runner, outputFormat)) {
    throw new RunnerCapabilityError(
      `runner '${runnerId}' does not support output format '${outputFormat}'`
    );
  }
  return outputFormat;
};

const resolveLaunchModel = (
  input: RunnerLaunchInput,
  actor: Option<ActorConfig>,
  runner: PipelineConfig["runners"][string]
): {
  model: Option<string>;
  variant: Option<ReasoningEffort>;
} => {
  const runnerOption = optionalRunner(runner);
  const model = firstSomeOf([
    optionalInputModel(input),
    optionalActorModel(actor),
    optionalRunnerModel(runnerOption),
  ]);
  const effort = firstSomeOf([
    optionalInputReasoningEffort(input),
    optionalActorEffort(actor),
    optionalRunnerEffort(runnerOption),
  ]);
  return { model, variant: resolveVariant(effort, model) };
};

const runnerLaunchBase = (
  input: RunnerLaunchInput,
  actor: Option<ActorConfig>,
  runner: PipelineConfig["runners"][string],
  runnerId: string
) => {
  const { model, variant } = resolveLaunchModel(input, actor, runner);
  return {
    cwd: input.worktreePath,
    env: {},
    nodeId: input.nodeId,
    outputFormat: resolveOutputFormat(actor, runner, runnerId),
    runnerId,
    type: runner.type,
    ...optionalIdleTimeoutField(agentIdleTimeoutMsFromEnv()),
    ...optionalModelField(model),
    ...optionalProfileIdField(optionalProfileId(input)),
    ...optionalProtectedPathsField(actor),
    ...optionalTimeoutField(
      firstSomeOf([optionalActorTimeout(actor), agentTimeoutMsFromEnv()])
    ),
    ...optionalVariantField(variant),
  };
};

const skillArgsFor = (): string[] => [];

export const harnessArgv = (
  prompt: string,
  worktreePath: string,
  contextFile: Option<string>,
  options: NativeArgOptions = {}
): string[] => {
  const actor = fromNullishOr(options.actor);
  const runner = fromNullishOr(options.runner);
  const model = fromNullishOr(options.model);
  const variant = fromNullishOr(options.variant);
  const skillArgs = skillArgsFor();
  if (matchOption(contextFile, { onNone: () => false, onSome: () => true })) {
    return [
      "run",
      "--format",
      "json",
      ...optionalModelArgs(runner, actor, model),
      ...optionalVariantArgs(variant),
      ...skillArgs,
      "--dangerously-skip-permissions",
      "--dir",
      worktreePath,
      prompt,
      "--file",
      getOrUndefined(contextFile) ?? "",
    ];
  }
  return [
    "run",
    "--format",
    "json",
    ...optionalModelArgs(runner, actor, model),
    ...optionalVariantArgs(variant),
    ...skillArgs,
    "--dangerously-skip-permissions",
    "--dir",
    worktreePath,
    prompt,
  ];
};

const declaredRunner = (
  config: PipelineConfig,
  runnerId: string
): PipelineConfig["runners"][string] => {
  if (!Object.hasOwn(config.runners, runnerId)) {
    throw new RunnerCapabilityError(`runner '${runnerId}' is not declared`);
  }
  return config.runners[runnerId];
};

const renderArgv = (args: string[], prompt: string, cwd: string): string[] =>
  args.map((arg) =>
    arg.replaceAll("{{prompt}}", prompt).replaceAll("{{cwd}}", cwd)
  );

const commandRunnerArgs = (
  runner: PipelineConfig["runners"][string],
  runnerId: string,
  input: RunnerLaunchInput
): string[] => {
  const command = fromNullishOr(runner.command);
  return matchOption(command, {
    onNone: () => {
      throw new RunnerCapabilityError(
        `command runner '${runnerId}' must declare command`
      );
    },
    onSome: () =>
      renderArgv(runner.args ?? [], input.prompt, input.worktreePath),
  });
};

const createActorLaunchPlan = (
  config: PipelineConfig,
  input: RunnerLaunchInput,
  actor: Option<ActorConfig>,
  runnerId: string
): RunnerLaunchPlan => {
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
      optionalContextFile(input),
      {
        ...matchOption(actor, {
          onNone: () => ({}),
          onSome: (value) => ({ actor: value }),
        }),
        ...matchOption(optionalInputModel(input), {
          onNone: () => ({}),
          onSome: (model) => ({ model }),
        }),
        runner,
        ...matchOption(fromNullishOr(base.variant), {
          onNone: () => ({}),
          onSome: (variant) => ({ variant }),
        }),
      }
    ),
    command,
  };
};

export const createRunnerLaunchPlan = (
  config: PipelineConfig,
  input: RunnerLaunchInput
): RunnerLaunchPlan => {
  const profile = runnerProfile(config, optionalProfileId(input));
  return createActorLaunchPlan(config, input, profile, runnerIdFor(profile));
};

export const createOrchestratorLaunchPlan = (
  config: PipelineConfig,
  input: Omit<RunnerLaunchInput, "profileId">
): RunnerLaunchPlan => {
  if (config.orchestrator === undefined) {
    throw new RunnerCapabilityError("orchestrator profile is not configured");
  }
  const profileId = config.orchestrator.profile;
  const profile = fromNullishOr(config.profiles[profileId]);
  return createActorLaunchPlan(
    config,
    { ...input, profileId },
    profile,
    runnerIdFor(profile)
  );
};
