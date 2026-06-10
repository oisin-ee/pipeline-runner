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
import type { PipelineConfig } from "./config";
import {
  buildRunnerCommandPayload,
  type MokaSubmission,
  type RunnerCommandPayload,
  type RunnerRepositoryContext,
  type RunnerRunIdentity,
  type RunnerTask,
  runnerDeliverySchema,
  runnerRepositoryContextSchema,
  runnerRunIdentitySchema,
  runnerTaskSchema,
} from "./runner-command-contract";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "./schedule-planner";
import { workflowSubmitResultSchema } from "./workflow-submit-contract";

const MOMOKAYA_EVENT_AUTH_SECRET_KEY = "OISIN_PIPELINE_EVENT_AUTH_TOKEN";
const MOMOKAYA_EVENT_AUTH_SECRET_NAME = "pipeline-runner-event-auth";
const MOMOKAYA_EVENT_URL =
  "https://pipeline-console.momokaya.ee/api/pipeline/runner-events";
const MOMOKAYA_GITHUB_AUTH_SECRET_NAME = "oisin-bot-github-auth";
const MOMOKAYA_IMAGE_PULL_SECRET_NAME = "ghcr-pull-secret";
const MOMOKAYA_OPENCODE_AUTH_SECRET_NAME = "opencode-auth-1";
const MOMOKAYA_QUEUE_NAME = "momokaya-pipeline";
const MOMOKAYA_RUNNER_SERVICE_ACCOUNT_NAME = "pipeline-runner";

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

export const mokaSubmitResultSchema = workflowSubmitResultSchema;

const mokaSubmitBaseOptionsSchema = z
  .object({
    delivery: runnerDeliverySchema.default({ pullRequest: false }),
    eventAuthSecretKey: z
      .string()
      .min(1)
      .default(MOMOKAYA_EVENT_AUTH_SECRET_KEY),
    eventAuthSecretName: z
      .string()
      .min(1)
      .default(MOMOKAYA_EVENT_AUTH_SECRET_NAME),
    eventUrl: z.string().url().default(MOMOKAYA_EVENT_URL),
    events: mokaSubmitEventsSchema.optional(),
    generateName: z.string().min(1).optional(),
    githubAuthSecretName: z
      .string()
      .min(1)
      .default(MOMOKAYA_GITHUB_AUTH_SECRET_NAME),
    image: z.string().min(1).optional(),
    imagePullPolicy: imagePullPolicySchema,
    imagePullSecretName: z
      .string()
      .min(1)
      .default(MOMOKAYA_IMAGE_PULL_SECRET_NAME),
    kubeconfigPath: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    namespace: z.string().min(1).default("momokaya-pipeline"),
    opencodeAuthSecretName: z
      .string()
      .min(1)
      .default(MOMOKAYA_OPENCODE_AUTH_SECRET_NAME),
    queueName: z.string().min(1).default(MOMOKAYA_QUEUE_NAME),
    repository: runnerRepositoryContextSchema.optional(),
    run: runnerRunIdentitySchema.optional(),
    serviceAccountName: z
      .string()
      .min(1)
      .default(MOMOKAYA_RUNNER_SERVICE_ACCOUNT_NAME),
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

export const mokaSubmitOptionsSchema = z.discriminatedUnion("type", [
  mokaGraphSubmitOptionsSchema,
  mokaCommandSubmitOptionsSchema,
]);

export type MokaSubmitOptionsInput = z.input<typeof mokaSubmitOptionsSchema>;
export type MokaSubmitOptionsOutput = z.output<typeof mokaSubmitOptionsSchema>;
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
  githubAuthSecretName?: string;
  image?: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  imagePullSecretName?: string;
  kubeconfigPath?: string;
  name?: string;
  namespace?: string;
  opencodeAuthSecretName?: string;
  payloadJson: string;
  queueName?: string;
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

export function submitMoka(
  rawOptions: MokaSubmitInput,
  dependencies: SubmitMokaDependencies = {}
): Promise<MokaSubmitOutput> {
  const { config, worktreePath, ...schemaOptions } = rawOptions;
  const options = mokaSubmitOptionsSchema.parse(schemaOptions);
  const parsedOptions: ParsedMokaSubmitOptions = {
    ...options,
    config,
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
    config: options.config,
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
    githubAuthSecretName: options.githubAuthSecretName,
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    imagePullSecretName: options.imagePullSecretName,
    kubeconfigPath: options.kubeconfigPath,
    name: options.name,
    namespace: options.namespace,
    opencodeAuthSecretName: options.opencodeAuthSecretName,
    queueName: options.queueName,
    serviceAccountName: options.serviceAccountName,
  };
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
  if (options.events) {
    return {
      authHeader: options.events.authHeader,
      authTokenFile:
        options.events.authTokenFile ?? eventAuthTokenFile(options),
      url: options.events.url,
    };
  }
  return {
    authHeader: "Authorization",
    authTokenFile: eventAuthTokenFile(options),
    url: options.eventUrl,
  };
}

function eventAuthTokenFile(options: ParsedMokaBaseOptions): string {
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
  return {
    repository: repositoryContext(options, git),
    run: runContext(options, git, runId),
  };
}

function explicitSubmissionContext(
  options: ParsedMokaBaseOptions
): MokaSubmissionContext | null {
  if (!(options.repository && options.run)) {
    return null;
  }
  return {
    repository: options.repository,
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
  return (
    options.repository ?? {
      baseBranch: git.baseBranch,
      sha: git.sha,
      url: git.url,
    }
  );
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
