import { buildCommandScheduleYaml } from "../../argo-submit";
import type { PipelineConfig } from "../../config";
import type {
  ParsedMokaCommandOptions,
  ParsedMokaGraphOptions,
  ParsedMokaSubmitOptions,
} from "../../moka-submit";
import {
  compileScheduleArtifact,
  type generateScheduleArtifactInMemory,
  parseScheduleArtifact,
} from "../../planning/generate";
import type { MokaSubmission, RunnerTask } from "../../runner-command-contract";
import { readScheduleFile } from "./io";

export interface MokaSubmitCompilationDependencies {
  generateSchedule?: typeof generateScheduleArtifactInMemory;
  readFile?: (path: string) => string;
}

export interface CompiledMokaSubmitPlan {
  config: PipelineConfig;
  dynamicScheduling: boolean;
  generateName: string;
  runId: string;
  scheduleYaml?: string;
  submission: MokaSubmission;
  task: RunnerTask;
  workflowId: string;
}

export function compileMokaSubmitPlan(input: {
  dependencies: MokaSubmitCompilationDependencies;
  options: ParsedMokaSubmitOptions;
  runId: string;
}): Promise<CompiledMokaSubmitPlan> {
  const plan =
    input.options.type === "command"
      ? compileMokaCommandSubmitPlan(input.options, input.runId)
      : compileMokaGraphSubmitPlan(
          input.options,
          input.dependencies,
          input.runId
        );
  return Promise.resolve(plan);
}

function compileMokaGraphSubmitPlan(
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies,
  runId: string
): CompiledMokaSubmitPlan {
  const task = normalizeTask(options.task);
  const scheduleYaml = readExplicitGraphScheduleYaml(options, dependencies);
  return {
    config: options.config,
    dynamicScheduling: !scheduleYaml,
    generateName: options.generateName ?? `moka-${options.mode}-`,
    runId,
    ...(scheduleYaml ? { scheduleYaml } : {}),
    submission: { kind: "graph", mode: options.mode },
    task,
    workflowId: scheduleYaml
      ? scheduleWorkflowId(options, scheduleYaml)
      : dynamicWorkflowId(runId),
  };
}

function compileMokaCommandSubmitPlan(
  options: ParsedMokaCommandOptions,
  runId: string
): CompiledMokaSubmitPlan {
  const task = commandTask(options);
  const scheduleYaml = buildCommandScheduleYaml({
    command: options.commandArgv,
    deliverPullRequest: options.delivery.pullRequest,
    scheduleId: runId,
    task: taskDescription(task),
  });
  return {
    config: options.config,
    dynamicScheduling: false,
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

function dynamicWorkflowId(runId: string): string {
  return `schedule-${runId}-root`;
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
