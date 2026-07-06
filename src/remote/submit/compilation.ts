import { Option } from "effect";
import { stringify } from "yaml";

import { buildCommandScheduleYaml } from "../../argo-submit";
import type { PipelineConfig } from "../../config";
import type { ParsedMokaCommandOptions, ParsedMokaGraphOptions, ParsedMokaSubmitOptions } from "../../moka-submit";
import { compileScheduleArtifact, parseScheduleArtifact } from "../../planning/generate";
import type { generateScheduleArtifactInMemory } from "../../planning/generate";
import type { MokaSubmission, RunnerTask } from "../../runner-command-contract";
import { appendPullRequestDelivery, shouldAppendPullRequestDelivery } from "../../schedule/passes/open-pull-request";
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

const readRawExplicitGraphScheduleYaml = (
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies,
): Option.Option<string> => {
  if (options.scheduleYaml !== undefined && options.scheduleYaml.length > 0) {
    return Option.some(options.scheduleYaml);
  }
  if (options.schedulePath !== undefined && options.schedulePath.length > 0) {
    return Option.some(readScheduleFile(dependencies, options.schedulePath));
  }
  return Option.none();
};

const graphScheduleYamlWithDelivery = (options: ParsedMokaGraphOptions, scheduleYaml: string): string => {
  const artifact = parseScheduleArtifact(scheduleYaml, "schedule.yaml");
  const transformed = appendPullRequestDelivery(
    shouldAppendPullRequestDelivery({
      config: options.config,
      requested: options.delivery.pullRequest,
    }),
    artifact,
  );
  return transformed === artifact ? scheduleYaml : stringify(transformed);
};

const readExplicitGraphScheduleYaml = (
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies,
): Option.Option<string> => {
  const scheduleYaml = readRawExplicitGraphScheduleYaml(options, dependencies);
  return Option.map(scheduleYaml, (source) => graphScheduleYamlWithDelivery(options, source));
};

const scheduleWorkflowId = (options: { config: PipelineConfig; worktreePath?: string }, scheduleYaml: string): string =>
  compileScheduleArtifact(options.config, parseScheduleArtifact(scheduleYaml, "schedule.yaml"), options.worktreePath)
    .workflowId;

const dynamicWorkflowId = (runId: string): string => `schedule-${runId}-root`;

const normalizeTask = (task: string | RunnerTask): RunnerTask => {
  if (typeof task === "string") {
    return { kind: "prompt", prompt: task };
  }
  return task;
};

const compileMokaGraphSubmitPlan = (
  options: ParsedMokaGraphOptions,
  dependencies: MokaSubmitCompilationDependencies,
  runId: string,
): CompiledMokaSubmitPlan => {
  const task = normalizeTask(options.task);
  const scheduleYaml = readExplicitGraphScheduleYaml(options, dependencies);
  const hasScheduleYaml = Option.isSome(scheduleYaml);
  return {
    config: options.config,
    dynamicScheduling: !hasScheduleYaml,
    generateName: options.generateName ?? `moka-${options.mode}-`,
    runId,
    ...(hasScheduleYaml ? { scheduleYaml: scheduleYaml.value } : {}),
    submission: { kind: "graph", mode: options.mode },
    task,
    workflowId: hasScheduleYaml ? scheduleWorkflowId(options, scheduleYaml.value) : dynamicWorkflowId(runId),
  };
};

const commandTask = (options: ParsedMokaCommandOptions): RunnerTask => {
  if (options.task !== undefined) {
    return normalizeTask(options.task);
  }
  return normalizeTask(options.commandArgv.join(" "));
};

const taskDescription = (task: RunnerTask): string => {
  if (task.kind === "prompt") {
    return task.prompt;
  }
  return task.title !== undefined && task.title.length > 0 ? `${task.id} ${task.title}` : task.id;
};

const compileMokaCommandSubmitPlan = (options: ParsedMokaCommandOptions, runId: string): CompiledMokaSubmitPlan => {
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
};

export const compileMokaSubmitPlan = (input: {
  dependencies: MokaSubmitCompilationDependencies;
  options: ParsedMokaSubmitOptions;
  runId: string;
}): CompiledMokaSubmitPlan => {
  const plan =
    input.options.type === "command"
      ? compileMokaCommandSubmitPlan(input.options, input.runId)
      : compileMokaGraphSubmitPlan(input.options, input.dependencies, input.runId);
  return plan;
};
