import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import parseGitUrl from "git-url-parse";
import { simpleGit } from "simple-git";
import { z } from "zod";
import {
  buildCommandScheduleYaml,
  type SubmitRunnerArgoWorkflowOptions,
  type SubmitRunnerArgoWorkflowResult,
  submitRunnerArgoWorkflow,
} from "./argo-submit";
import type { PipelineConfig } from "./config";
import {
  buildRunnerCommandPayload,
  type MokaSubmission,
} from "./runner-command-contract";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "./schedule-planner";

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

const mokaSubmitBaseOptionsSchema = z
  .object({
    eventUrl: z.string().url().default(MOMOKAYA_EVENT_URL),
    generateName: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    imagePullPolicy: imagePullPolicySchema,
    imagePullSecretName: z
      .string()
      .min(1)
      .default(MOMOKAYA_IMAGE_PULL_SECRET_NAME),
    kubeconfigPath: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    namespace: z.string().min(1).default("momokaya-pipeline"),
    queueName: z.string().min(1).default(MOMOKAYA_QUEUE_NAME),
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
    task: z.string().min(1),
    type: z.literal("graph"),
  })
  .strict();

const mokaCommandSubmitOptionsSchema = mokaSubmitBaseOptionsSchema
  .extend({
    commandArgv: z.array(z.string().min(1)).min(1),
    task: z.string().min(1).optional(),
    type: z.literal("command"),
  })
  .strict();

const mokaSubmitOptionsSchema = z.discriminatedUnion("type", [
  mokaGraphSubmitOptionsSchema,
  mokaCommandSubmitOptionsSchema,
]);

type MokaSubmitOptions = z.input<typeof mokaSubmitOptionsSchema> & {
  config: PipelineConfig;
  worktreePath: string;
};

type ParsedMokaSubmitOptions = z.output<typeof mokaSubmitOptionsSchema> & {
  config: PipelineConfig;
  worktreePath: string;
};

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
    options: SubmitRunnerArgoWorkflowOptions
  ) => Promise<SubmitRunnerArgoWorkflowResult>;
}

type ParsedMokaGraphOptions = z.output<typeof mokaGraphSubmitOptionsSchema> & {
  config: PipelineConfig;
  worktreePath: string;
};

type ParsedMokaCommandOptions = z.output<
  typeof mokaCommandSubmitOptionsSchema
> & {
  config: PipelineConfig;
  worktreePath: string;
};

type ParsedMokaBaseOptions = z.output<typeof mokaSubmitBaseOptionsSchema>;

export function submitMoka(
  rawOptions: MokaSubmitOptions,
  dependencies: SubmitMokaDependencies = {}
): Promise<SubmitRunnerArgoWorkflowResult> {
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

async function submitMokaGraph(
  options: ParsedMokaGraphOptions,
  dependencies: SubmitMokaDependencies
): Promise<SubmitRunnerArgoWorkflowResult> {
  const git = await resolveGit(options.worktreePath, dependencies);
  const submitWorkflow =
    dependencies.submitWorkflow ?? submitRunnerArgoWorkflow;
  const runId = generateRunId(dependencies);
  const scheduleYaml = await graphScheduleYaml(options, dependencies, runId);
  const workflowId = scheduleWorkflowId(options, scheduleYaml);
  return submitWorkflow({
    ...workflowSubmitOptions(options),
    config: options.config,
    generateName: options.generateName ?? `moka-${options.mode}-`,
    payloadJson: runnerPayloadJson({
      git,
      options,
      submission: { kind: "graph", mode: options.mode },
      task: options.task,
      runId,
      workflowId,
    }),
    scheduleYaml,
  });
}

async function submitMokaCommand(
  options: ParsedMokaCommandOptions,
  dependencies: SubmitMokaDependencies
): Promise<SubmitRunnerArgoWorkflowResult> {
  const git = await resolveGit(options.worktreePath, dependencies);
  const task = options.task ?? options.commandArgv.join(" ");
  const submitWorkflow =
    dependencies.submitWorkflow ?? submitRunnerArgoWorkflow;
  const runId = generateRunId(dependencies);
  const scheduleYaml = buildCommandScheduleYaml({
    command: options.commandArgv,
    scheduleId: runId,
    task,
  });
  const workflowId = scheduleWorkflowId(options, scheduleYaml);
  return submitWorkflow({
    ...workflowSubmitOptions(options),
    config: options.config,
    generateName: options.generateName ?? "moka-command-",
    payloadJson: runnerPayloadJson({
      git,
      options,
      submission: { argv: options.commandArgv, kind: "command" },
      task,
      runId,
      workflowId,
    }),
    scheduleYaml,
  });
}

async function graphScheduleYaml(
  options: z.output<typeof mokaGraphSubmitOptionsSchema> & {
    config: PipelineConfig;
    worktreePath: string;
  },
  dependencies: SubmitMokaDependencies,
  runId: string
): Promise<string> {
  const readFile =
    dependencies.readFile ?? ((path) => readFileSync(path, "utf8"));
  if (options.schedulePath) {
    return readFile(options.schedulePath);
  }
  const generateSchedule =
    dependencies.generateSchedule ?? generateScheduleArtifact;
  const schedule = await generateSchedule({
    config: options.config,
    entrypointId: options.mode === "quick" ? "quick" : "execute",
    runId,
    task: options.task,
    worktreePath: options.worktreePath,
  });
  return readFile(resolve(options.worktreePath, schedule.path));
}

function scheduleWorkflowId(
  options: { config: PipelineConfig; worktreePath: string },
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
): Omit<
  SubmitRunnerArgoWorkflowOptions,
  "config" | "payloadJson" | "scheduleYaml"
> {
  return {
    eventAuthSecretKey: MOMOKAYA_EVENT_AUTH_SECRET_KEY,
    eventAuthSecretName: MOMOKAYA_EVENT_AUTH_SECRET_NAME,
    githubAuthSecretName: MOMOKAYA_GITHUB_AUTH_SECRET_NAME,
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    imagePullSecretName: options.imagePullSecretName,
    kubeconfigPath: options.kubeconfigPath,
    name: options.name,
    namespace: options.namespace,
    opencodeAuthSecretName: MOMOKAYA_OPENCODE_AUTH_SECRET_NAME,
    queueName: options.queueName,
    serviceAccountName: options.serviceAccountName,
  };
}

function runnerPayloadJson(input: {
  git: MokaGitContext;
  options: ParsedMokaBaseOptions;
  submission: MokaSubmission;
  runId: string;
  task: string;
  workflowId: string;
}): string {
  return JSON.stringify(
    buildRunnerCommandPayload({
      delivery: { pullRequest: false },
      events: runnerEvents(input.options),
      repository: {
        baseBranch: input.git.baseBranch,
        sha: input.git.sha,
        url: input.git.url,
      },
      run: {
        id: input.runId,
        project: input.git.project,
      },
      submission: input.submission,
      task: { kind: "prompt", prompt: input.task },
      workflow: { id: input.workflowId },
    })
  );
}

function runnerEvents(options: ParsedMokaBaseOptions) {
  return {
    authHeader: "Authorization",
    authTokenFile: `/etc/pipeline/event-auth/${MOMOKAYA_EVENT_AUTH_SECRET_KEY}`,
    url: options.eventUrl,
  };
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
