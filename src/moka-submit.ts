import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import parseGitUrl from "git-url-parse";
import { simpleGit } from "simple-git";
import { z } from "zod";
import {
  buildCommandScheduleYaml,
  submitRunnerArgoWorkflow,
} from "./argo-submit";
import type { HookEvent, PipelineConfig } from "./config";
import { normalizeRunnerRepositoryForSubmit } from "./git-remote-url";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "./planning/generate";
import {
  buildRunnerCommandPayload,
  type MokaSubmission,
  type RunnerCommandPayload,
  type RunnerRepositoryContext,
  type RunnerRunIdentity,
  type RunnerTask,
  runnerDeliverySchema,
  runnerHookPolicySchema,
  runnerRepositoryContextSchema,
  runnerRunIdentitySchema,
  runnerTaskSchema,
} from "./runner-command-contract";
import { workflowSubmitResultSchema } from "./workflow-submit-contract";

const imagePullPolicySchema = z
  .enum(["Always", "IfNotPresent", "Never"])
  .default("Always");

const mokaSubmitTaskInputSchema = z.union([
  z.string().min(1),
  runnerTaskSchema,
]);

const mokaSubmitEventsSchema = z
  .object({
    authHeader: z.string().min(1).default("Authorization"),
    authTokenFile: z.string().min(1).optional(),
    url: z.string().url(),
  })
  .strict();

const MOKA_SUBMIT_HOOK_EVENTS = [
  "workflow.start",
  "workflow.success",
  "workflow.failure",
  "workflow.complete",
  "node.start",
  "node.success",
  "node.error",
  "node.finish",
  "gate.failure",
] as const satisfies readonly HookEvent[];

const mokaSubmitHookWhereSchema = z
  .object({
    gate: z.string().min(1).optional(),
    node: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
  })
  .strict();

const mokaSubmitHookBaseSchema = z
  .object({
    failure: z.enum(["fail", "ignore"]).default("ignore"),
    input: z.record(z.string(), z.unknown()).optional(),
    publishResult: z.boolean().optional(),
    saveResultAs: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    where: mokaSubmitHookWhereSchema.optional(),
  })
  .strict();

const mokaSubmitCommandHookSchema = mokaSubmitHookBaseSchema
  .extend({
    command: z.array(z.string().min(1)).min(1),
    kind: z.literal("command"),
    outputLimitBytes: z.number().int().positive().optional(),
    trusted: z.boolean().optional(),
  })
  .strict();

const mokaSubmitModuleHookSchema = mokaSubmitHookBaseSchema
  .extend({
    kind: z.literal("module"),
    module: z.string().min(1),
  })
  .strict();

const mokaSubmitDirectHookSchema = z.discriminatedUnion("kind", [
  mokaSubmitCommandHookSchema,
  mokaSubmitModuleHookSchema,
]);

export const mokaSubmitDirectHooksSchema = z.partialRecord(
  z.enum(MOKA_SUBMIT_HOOK_EVENTS),
  mokaSubmitDirectHookSchema
);

export const mokaSubmitHookPolicySchema = runnerHookPolicySchema;

export const mokaSubmitResultSchema = workflowSubmitResultSchema;

const mokaSubmitBaseOptionsSchema = z
  .object({
    delivery: runnerDeliverySchema.default({ pullRequest: false }),
    eventSink: mokaSubmitEventsSchema.optional(),
    eventAuthSecretKey: z.string().min(1).optional(),
    eventAuthSecretName: z.string().min(1).optional(),
    eventUrl: z.string().url().optional(),
    events: mokaSubmitEventsSchema.optional(),
    generateName: z.string().min(1).optional(),
    gitCredentialsSecretName: z.string().min(1).optional(),
    githubAuthSecretName: z.string().min(1).optional(),
    hookPolicy: mokaSubmitHookPolicySchema.optional(),
    hooks: mokaSubmitDirectHooksSchema.optional(),
    image: z.string().min(1).optional(),
    imagePullPolicy: imagePullPolicySchema,
    imagePullSecretName: z.string().min(1).optional(),
    kubeconfigPath: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    opencodeAuthSecretName: z.string().min(1).optional(),
    repository: runnerRepositoryContextSchema.optional(),
    run: runnerRunIdentitySchema.optional(),
    serviceAccountName: z.string().min(1).optional(),
  })
  .strict();

const mokaGraphSubmitOptionsSchema = mokaSubmitBaseOptionsSchema
  .extend({
    mode: z.enum(["full", "quick"]),
    schedulePath: z.string().min(1).optional(),
    scheduleYaml: z.string().min(1).optional(),
    task: mokaSubmitTaskInputSchema,
    type: z.literal("graph"),
  })
  .strict();

const mokaCommandSubmitOptionsSchema = mokaSubmitBaseOptionsSchema
  .extend({
    commandArgv: z.array(z.string().min(1)).min(1),
    task: mokaSubmitTaskInputSchema.optional(),
    type: z.literal("command"),
  })
  .strict();

export const mokaSubmitOptionsSchema = z
  .discriminatedUnion("type", [
    mokaGraphSubmitOptionsSchema,
    mokaCommandSubmitOptionsSchema,
  ])
  .superRefine((data, ctx) => {
    if (data.eventSink !== undefined && data.events !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Choose either eventSink or events, not both",
        path: ["eventSink"],
      });
    }
    if (
      data.eventSink === undefined &&
      data.events === undefined &&
      data.eventUrl === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "eventUrl is required unless eventSink or events is provided",
        path: ["eventUrl"],
      });
    }
  });

export type MokaSubmitOptionsInput = z.input<typeof mokaSubmitOptionsSchema>;
export type MokaSubmitOptionsOutput = z.output<typeof mokaSubmitOptionsSchema>;
export type MokaSubmitDirectHooksInput = z.input<
  typeof mokaSubmitDirectHooksSchema
>;
export type MokaSubmitDirectHooksOutput = z.output<
  typeof mokaSubmitDirectHooksSchema
>;
export type MokaSubmitHookPolicyInput = z.input<
  typeof mokaSubmitHookPolicySchema
>;
export type MokaSubmitHookPolicyOutput = z.output<
  typeof mokaSubmitHookPolicySchema
>;
export type MokaSubmitInput = MokaSubmitOptionsInput & {
  config: PipelineConfig;
  worktreePath?: string;
};

type ParsedMokaSubmitOptions = z.output<typeof mokaSubmitOptionsSchema> & {
  config: PipelineConfig;
  worktreePath?: string;
};

export type MokaSubmitOptions = MokaSubmitInput;
export type MokaSubmitOutput = z.output<typeof mokaSubmitResultSchema>;
export type MokaSubmitResult = MokaSubmitOutput;

interface MokaGitContext {
  baseBranch: string;
  project: string;
  sha: string;
  url: string;
}

interface SubmitMokaDependencies {
  generateRunId?: () => string;
  generateSchedule?: typeof generateScheduleArtifact;
  readFile?: (path: string) => string;
  resolveGitContext?: (worktreePath: string) => Promise<MokaGitContext>;
  submitWorkflow?: (
    options: MokaWorkflowSubmitOptions
  ) => Promise<MokaSubmitOutput>;
}

interface MokaWorkflowSubmitOptions {
  config: PipelineConfig;
  eventAuthSecretKey?: string;
  eventAuthSecretName?: string;
  generateName?: string;
  gitCredentialsSecretName?: string;
  githubAuthSecretName?: string;
  image?: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  imagePullSecretName?: string;
  kubeconfigPath?: string;
  name?: string;
  namespace: string;
  opencodeAuthSecretName?: string;
  payloadJson: string;
  scheduleYaml: string;
  serviceAccountName?: string;
}

type ParsedMokaGraphOptions = z.output<typeof mokaGraphSubmitOptionsSchema> & {
  config: PipelineConfig;
  worktreePath?: string;
};

type ParsedMokaCommandOptions = z.output<
  typeof mokaCommandSubmitOptionsSchema
> & {
  config: PipelineConfig;
  worktreePath?: string;
};

type ParsedMokaBaseOptions = z.output<typeof mokaSubmitBaseOptionsSchema>;

type ParsedMokaWithRun = ParsedMokaBaseOptions & {
  run?: RunnerRunIdentity;
};

type MokaSubmitDirectHooks = z.output<typeof mokaSubmitDirectHooksSchema>;
type MokaSubmitDirectHook = z.output<typeof mokaSubmitDirectHookSchema>;

const submitHookId = (event: HookEvent) =>
  `moka-submit-${event.replaceAll(".", "-")}`;

function objectWithoutUndefined<T extends Record<string, unknown>>(
  value: T
): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

function hookFunctionForSubmitHook(hook: MokaSubmitDirectHook) {
  if (hook.kind === "module") {
    return objectWithoutUndefined({
      kind: "module" as const,
      module: hook.module,
      timeout_ms: hook.timeoutMs,
    });
  }

  return objectWithoutUndefined({
    command: hook.command,
    kind: "command" as const,
    output_limit_bytes: hook.outputLimitBytes,
    protocol: { input: "file" as const, result: "file" as const },
    timeout_ms: hook.timeoutMs,
    trusted: hook.trusted,
  });
}

function hookBindingForSubmitHook(
  event: HookEvent,
  hook: MokaSubmitDirectHook
) {
  const id = submitHookId(event);
  const result =
    hook.publishResult === undefined && hook.saveResultAs === undefined
      ? undefined
      : objectWithoutUndefined({
          publish: hook.publishResult,
          save_as: hook.saveResultAs,
        });

  return objectWithoutUndefined({
    failure: hook.failure,
    function: id,
    id,
    result,
    where: hook.where,
    with: hook.input,
  });
}

function submitHookEntries(hooks: MokaSubmitDirectHooks | undefined): Array<{
  event: HookEvent;
  hook: MokaSubmitDirectHook;
}> {
  return (
    Object.entries(hooks ?? {}) as [
      HookEvent,
      MokaSubmitDirectHook | undefined,
    ][]
  )
    .filter(
      (entry): entry is [HookEvent, MokaSubmitDirectHook] =>
        entry[1] !== undefined
    )
    .map(([event, hook]) => ({ event, hook }));
}

function cloneHookBindings(
  on: PipelineConfig["hooks"]["on"]
): PipelineConfig["hooks"]["on"] {
  return Object.fromEntries(
    Object.entries(on).map(([event, bindings]) => [event, [...bindings]])
  ) as PipelineConfig["hooks"]["on"];
}

function appendSubmitHook(
  event: HookEvent,
  hook: MokaSubmitDirectHook,
  target: Pick<PipelineConfig["hooks"], "functions" | "on">
): void {
  const id = submitHookId(event);
  if (target.functions[id] !== undefined) {
    throw new Error(`Moka submit hook id already exists in config: ${id}`);
  }
  target.functions[id] = hookFunctionForSubmitHook(hook);
  target.on[event] = [
    ...(target.on[event] ?? []),
    hookBindingForSubmitHook(event, hook),
  ];
}

function configWithSubmitHooks(
  config: PipelineConfig,
  hooks: MokaSubmitDirectHooks | undefined
): PipelineConfig {
  const entries = submitHookEntries(hooks);
  if (entries.length === 0) {
    return config;
  }

  const target = {
    functions: { ...config.hooks.functions },
    on: cloneHookBindings(config.hooks.on),
  };

  for (const { event, hook } of entries) {
    appendSubmitHook(event, hook, target);
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      functions: target.functions,
      on: target.on,
    },
  };
}

function withPullRequestDelivery(
  config: PipelineConfig,
  delivery: z.output<typeof runnerDeliverySchema>
): PipelineConfig {
  return {
    ...config,
    delivery: {
      pull_request: {
        enabled: delivery.pullRequest === true,
        label: config.delivery?.pull_request?.label ?? "preview",
      },
    },
  };
}

export function submitMoka(
  rawOptions: MokaSubmitInput,
  dependencies: SubmitMokaDependencies = {}
): Promise<MokaSubmitOutput> {
  const { config, worktreePath, ...schemaOptions } = rawOptions;
  const options = mokaSubmitOptionsSchema.parse(schemaOptions);
  const parsedOptions: ParsedMokaSubmitOptions = {
    ...options,
    config: configWithSubmitHooks(config, options.hooks),
    worktreePath,
  };
  return parsedOptions.type === "command"
    ? submitMokaCommand(parsedOptions, dependencies)
    : submitMokaGraph(parsedOptions, dependencies);
}

function resolveSubmitWorkflow(
  dependencies: SubmitMokaDependencies
): (options: MokaWorkflowSubmitOptions) => Promise<MokaSubmitOutput> {
  return dependencies.submitWorkflow ?? submitRunnerArgoWorkflow;
}

function submitRunId(
  options: ParsedMokaWithRun,
  dependencies: SubmitMokaDependencies
): string {
  return options.run?.id ?? generateRunId(dependencies);
}

function commandTask(options: ParsedMokaCommandOptions): RunnerTask {
  if (options.task) {
    return normalizeTask(options.task);
  }
  return normalizeTask(options.commandArgv.join(" "));
}

async function submitMokaGraph(
  options: ParsedMokaGraphOptions,
  dependencies: SubmitMokaDependencies
): Promise<MokaSubmitOutput> {
  const submitWorkflow = resolveSubmitWorkflow(dependencies);
  const runId = submitRunId(options, dependencies);
  const task = normalizeTask(options.task);
  const context = await resolveSubmissionContext(options, dependencies, runId);
  const scheduleYaml = await graphScheduleYaml(
    options,
    dependencies,
    runId,
    taskDescription(task)
  );
  const workflowId = scheduleWorkflowId(options, scheduleYaml);
  const result = await submitWorkflow({
    ...workflowSubmitOptions(options),
    config: options.config,
    generateName: options.generateName ?? `moka-${options.mode}-`,
    payloadJson: runnerPayloadJson({
      context,
      options,
      submission: { kind: "graph", mode: options.mode },
      task,
      runId,
      workflowId,
    }),
    scheduleYaml,
  });
  return mokaSubmitResultSchema.parse(result);
}

async function submitMokaCommand(
  options: ParsedMokaCommandOptions,
  dependencies: SubmitMokaDependencies
): Promise<MokaSubmitOutput> {
  const runId = submitRunId(options, dependencies);
  const task = commandTask(options);
  const context = await resolveSubmissionContext(options, dependencies, runId);
  const submitWorkflow = resolveSubmitWorkflow(dependencies);
  const scheduleYaml = buildCommandScheduleYaml({
    command: options.commandArgv,
    scheduleId: runId,
    task: taskDescription(task),
  });
  const workflowId = scheduleWorkflowId(options, scheduleYaml);
  const result = await submitWorkflow({
    ...workflowSubmitOptions(options),
    config: options.config,
    generateName: options.generateName ?? "moka-command-",
    payloadJson: runnerPayloadJson({
      context,
      options,
      submission: { argv: options.commandArgv, kind: "command" },
      task,
      runId,
      workflowId,
    }),
    scheduleYaml,
  });
  return mokaSubmitResultSchema.parse(result);
}

async function graphScheduleYaml(
  options: z.output<typeof mokaGraphSubmitOptionsSchema> & {
    config: PipelineConfig;
    worktreePath?: string;
  },
  dependencies: SubmitMokaDependencies,
  runId: string,
  task: string
): Promise<string> {
  const explicitScheduleYaml = readExplicitGraphScheduleYaml(
    options,
    dependencies
  );
  if (explicitScheduleYaml) {
    return explicitScheduleYaml;
  }
  const worktreePath = requireScheduleWorktreePath(options);
  const generateSchedule =
    dependencies.generateSchedule ?? generateScheduleArtifact;
  const schedule = await generateSchedule({
    config: withPullRequestDelivery(options.config, options.delivery),
    entrypointId: options.mode === "quick" ? "quick" : "execute",
    runId,
    task,
    worktreePath,
  });
  return readScheduleFile(dependencies, resolve(worktreePath, schedule.path));
}

function readExplicitGraphScheduleYaml(
  options: z.output<typeof mokaGraphSubmitOptionsSchema>,
  dependencies: SubmitMokaDependencies
): string | null {
  if (options.scheduleYaml) {
    return options.scheduleYaml;
  }
  if (options.schedulePath) {
    return readScheduleFile(dependencies, options.schedulePath);
  }
  return null;
}

function readScheduleFile(
  dependencies: SubmitMokaDependencies,
  path: string
): string {
  const readFile =
    dependencies.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  return readFile(path);
}

function requireScheduleWorktreePath(options: {
  worktreePath?: string;
}): string {
  if (!options.worktreePath) {
    throw new Error(
      "worktreePath is required when moka submit generates a graph schedule"
    );
  }
  return options.worktreePath;
}

function scheduleWorkflowId(
  options: { config: PipelineConfig; worktreePath?: string },
  scheduleYaml: string
): string {
  return compileScheduleArtifact(
    options.config,
    parseScheduleArtifact(scheduleYaml, "schedule.yaml"),
    options.worktreePath
  ).workflowId;
}

function workflowSubmitOptions(
  options: ParsedMokaBaseOptions
): Omit<MokaWorkflowSubmitOptions, "config" | "payloadJson" | "scheduleYaml"> {
  return {
    eventAuthSecretKey: options.eventAuthSecretKey,
    eventAuthSecretName: options.eventAuthSecretName,
    gitCredentialsSecretName: options.gitCredentialsSecretName,
    githubAuthSecretName: options.githubAuthSecretName,
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    imagePullSecretName: options.imagePullSecretName,
    kubeconfigPath: options.kubeconfigPath,
    name: options.name,
    namespace: requireSubmitOption(options.namespace, "namespace"),
    opencodeAuthSecretName: options.opencodeAuthSecretName,
    serviceAccountName: options.serviceAccountName,
  };
}

function requireSubmitOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for moka submit`);
  }
  return value;
}

interface MokaSubmissionContext {
  repository: RunnerRepositoryContext;
  run: RunnerRunIdentity;
}

function runnerPayloadJson(input: {
  context: MokaSubmissionContext;
  options: ParsedMokaBaseOptions;
  submission: MokaSubmission;
  runId: string;
  task: RunnerTask;
  workflowId: string;
}): string {
  return JSON.stringify(
    buildRunnerCommandPayload({
      delivery: input.options.delivery,
      events: runnerEvents(input.options),
      hookPolicy: input.options.hookPolicy,
      repository: {
        baseBranch: input.context.repository.baseBranch,
        sha: input.context.repository.sha,
        url: input.context.repository.url,
      },
      run: {
        id: input.runId,
        project: input.context.run.project,
        requestedBy: input.context.run.requestedBy,
      },
      submission: input.submission,
      task: input.task,
      workflow: { id: input.workflowId },
    })
  );
}

function runnerEvents(
  options: ParsedMokaBaseOptions
): RunnerCommandPayload["events"] {
  const eventSink = options.eventSink ?? options.events;
  if (eventSink) {
    return {
      authHeader: eventSink.authHeader,
      authTokenFile: eventSink.authTokenFile ?? eventAuthTokenFile(options),
      url: eventSink.url,
    };
  }
  if (!options.eventUrl) {
    throw new Error(
      "eventUrl is required unless eventSink or events is provided"
    );
  }
  return {
    authHeader: "Authorization",
    authTokenFile: eventAuthTokenFile(options),
    url: options.eventUrl,
  };
}

function eventAuthTokenFile(options: ParsedMokaBaseOptions): string {
  if (!options.eventAuthSecretKey) {
    throw new Error(
      "eventAuthSecretKey is required unless eventSink.authTokenFile is provided"
    );
  }
  return `/etc/pipeline/event-auth/${options.eventAuthSecretKey}`;
}

async function resolveSubmissionContext(
  options: ParsedMokaBaseOptions & { worktreePath?: string },
  dependencies: SubmitMokaDependencies,
  runId: string
): Promise<MokaSubmissionContext> {
  const explicitContext = explicitSubmissionContext(options);
  if (explicitContext) {
    return explicitContext;
  }
  const git = await resolveRequiredGit(options, dependencies);
  const repository = repositoryContext(options, git);
  assertRepositoryCredentialConfiguration(options);
  return {
    repository,
    run: runContext(options, git, runId),
  };
}

function explicitSubmissionContext(
  options: ParsedMokaBaseOptions
): MokaSubmissionContext | null {
  if (!(options.repository && options.run)) {
    return null;
  }
  assertRepositoryCredentialConfiguration(options);
  return {
    repository: normalizeRunnerRepositoryForSubmit(options.repository),
    run: options.run,
  };
}

function resolveRequiredGit(
  options: { worktreePath?: string },
  dependencies: SubmitMokaDependencies
): Promise<MokaGitContext> {
  if (!options.worktreePath) {
    throw new Error(
      "worktreePath is required when moka submit must resolve repository or run context"
    );
  }
  return resolveGit(options.worktreePath, dependencies);
}

function repositoryContext(
  options: ParsedMokaBaseOptions,
  git: MokaGitContext
): RunnerRepositoryContext {
  return normalizeRunnerRepositoryForSubmit(
    options.repository ?? {
      baseBranch: git.baseBranch,
      sha: git.sha,
      url: git.url,
    }
  );
}

function assertRepositoryCredentialConfiguration(
  options: ParsedMokaBaseOptions
): void {
  if (!options.gitCredentialsSecretName) {
    throw new Error(
      "gitCredentialsSecretName is required for runner git clone, fetch, and push operations"
    );
  }
}

function runContext(
  options: ParsedMokaBaseOptions,
  git: MokaGitContext,
  runId: string
): RunnerRunIdentity {
  return (
    options.run ?? {
      id: runId,
      project: git.project,
    }
  );
}

function normalizeTask(task: string | RunnerTask): RunnerTask {
  if (typeof task === "string") {
    return { kind: "prompt", prompt: task };
  }
  return task;
}

function taskDescription(task: RunnerTask): string {
  if (task.kind === "prompt") {
    return task.prompt;
  }
  return task.title ? `${task.id} ${task.title}` : task.id;
}

async function resolveGit(
  worktreePath: string,
  dependencies: SubmitMokaDependencies
): Promise<MokaGitContext> {
  if (dependencies.resolveGitContext) {
    return dependencies.resolveGitContext(worktreePath);
  }
  const git = simpleGit({ baseDir: worktreePath });
  const [branchResult, sha, remoteConfig] = await Promise.all([
    git.branch(),
    git.revparse(["HEAD"]),
    git.getConfig("remote.origin.url"),
  ]);
  const url = remoteConfig.value;
  if (!url) {
    throw new Error(
      "Could not resolve git remote origin URL. Ensure the repository has a remote configured."
    );
  }
  return {
    baseBranch: branchResult.current,
    project: parseGitUrl(url).name || "unknown",
    sha: sha.trim(),
    url,
  };
}

function generateRunId(dependencies: SubmitMokaDependencies): string {
  return (
    dependencies.generateRunId?.() ?? `run-${randomBytes(8).toString("hex")}`
  );
}
