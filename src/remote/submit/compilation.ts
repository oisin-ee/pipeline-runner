import { resolve } from "node:path";
import { buildCommandScheduleYaml } from "../../argo-submit";
import type { PipelineConfig } from "../../config";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "../../planning/generate";
import type {
  MokaSubmission,
  RunnerDelivery,
  RunnerRepositoryContext,
  RunnerTask,
} from "../../runner-command-contract";
import type {
  ParsedMokaCommandOptions,
  ParsedMokaGraphOptions,
  ParsedMokaSubmitOptions,
} from "./contract";
import { readScheduleFile } from "./io";

export interface MokaSubmitCompilationDependencies {
  generateSchedule?: typeof generateScheduleArtifact;
  readFile?: (path: string) => string;
}

export interface CompiledMokaSubmitPlan {
  config: PipelineConfig;
  generateName: string;
  runId: string;
  scheduleYaml: string;
  submission: MokaSubmission;
  task: RunnerTask;
  workflowId: string;
}

export function compileMokaSubmitPlan(input: {
  dependencies: MokaSubmitCompilationDependencies;
  options: ParsedMokaSubmitOptions;
  runId: string;
}): Promise<CompiledMokaSubmitPlan> {
  return input.options.type === "command"
    ? Promise.resolve(compileMokaCommandSubmitPlan(input.options, input.runId))
    : compileMokaGraphSubmitPlan(
        input.options,
        input.dependencies,
        input.runId
      );
}

async function compileMokaGraphSubmitPlan(
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies,
  runId: string
): Promise<CompiledMokaSubmitPlan> {
  const task = normalizeTask(options.task);
  const scheduleYaml = await graphScheduleYaml(
    options,
    dependencies,
    runId,
    taskDescription(task)
  );
  return {
    config: options.config,
    generateName: options.generateName ?? `moka-${options.mode}-`,
    runId,
    scheduleYaml,
    submission: { kind: "graph", mode: options.mode },
    task,
    workflowId: scheduleWorkflowId(options, scheduleYaml),
  };
}

function compileMokaCommandSubmitPlan(
  options: ParsedMokaCommandOptions,
  runId: string
): CompiledMokaSubmitPlan {
  const task = commandTask(options);
  const scheduleYaml = buildCommandScheduleYaml({
    command: options.commandArgv,
    scheduleId: runId,
    task: taskDescription(task),
  });
  return {
    config: options.config,
    generateName: options.generateName ?? "moka-command-",
    runId,
    scheduleYaml,
    submission: { argv: options.commandArgv, kind: "command" },
    task,
    workflowId: scheduleWorkflowId(options, scheduleYaml),
  };
}

function commandTask(options: ParsedMokaCommandOptions): RunnerTask {
  if (options.task) {
    return normalizeTask(options.task);
  }
  return normalizeTask(options.commandArgv.join(" "));
}

async function graphScheduleYaml(
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies,
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
    config: withPullRequestDelivery(
      options.config,
      options.delivery,
      options.repository
    ),
    entrypointId: options.mode === "quick" ? "quick" : "execute",
    runId,
    task,
    worktreePath,
  });
  return readScheduleFile(dependencies, resolve(worktreePath, schedule.path));
}

function readExplicitGraphScheduleYaml(
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies
): string | null {
  if (options.scheduleYaml) {
    return options.scheduleYaml;
  }
  if (options.schedulePath) {
    return readScheduleFile(dependencies, options.schedulePath);
  }
  return null;
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

function withPullRequestDelivery(
  config: PipelineConfig,
  delivery: RunnerDelivery,
  repository?: RunnerRepositoryContext
): PipelineConfig {
  return {
    ...config,
    delivery: {
      pull_request: pullRequestDelivery(config, delivery, repository),
    },
  };
}

function pullRequestDelivery(
  config: PipelineConfig,
  delivery: RunnerDelivery,
  repository?: RunnerRepositoryContext
): NonNullable<PipelineConfig["delivery"]>["pull_request"] {
  return {
    enabled: delivery.pullRequest === true,
    ...pullRequestHeadBranch(repository),
    label: pullRequestLabel(config),
    mode: delivery.mode,
  };
}

function pullRequestLabel(config: PipelineConfig): string {
  return config.delivery?.pull_request?.label ?? "preview";
}

function pullRequestHeadBranch(
  repository: RunnerRepositoryContext | undefined
): { head_branch?: string } {
  if (repository?.headBranch) {
    return { head_branch: repository.headBranch };
  }
  return {};
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
