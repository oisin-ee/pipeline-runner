import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { runPipelineFromConfig } from "../pipeline-runtime";
import { compileWorkflowPlan } from "../planning/compile";
import {
  compileScheduleArtifact,
  generateScheduleArtifactInMemory,
  parseScheduleArtifact,
} from "../planning/generate";
import { flattenNodes } from "../planning/graph";
import type { RunEffort, RunMode, RunTarget } from "../run-control/contracts";
import {
  type StartDetachedRunControllerInput,
  startDetachedRunController,
} from "../run-control/detach";
import {
  type RunControlStore,
  withRunControlStoreScoped,
} from "../run-control/run-control-store";
import { createRunStoreRuntimeReporter } from "../run-control/runtime-reporter";
import { createRunControlSupervisor } from "../run-control/supervisor";
import {
  generateRuntimeRunId,
  resolveWorkflowSelection,
} from "../runtime/context";
import {
  createTerminalRuntimeReporter,
  formatRuntimeFailure,
  formatRuntimeResult,
} from "./format";
import type { LocalRuntimeExecution } from "./run-resolver";

export interface ExecuteOptions {
  entrypoint?: string;
  pipelineRunner?: typeof runPipelineFromConfig;
  runControl?: RunControlOptions;
  runId?: string;
  runStoreMode?: RunStoreMode;
  schedule?: string;
  supervised?: boolean;
  supervisor?: boolean;
  workflow?: string;
}

export type RunStoreMode = "create" | "reuse";

export interface RunControlOptions {
  effort?: RunEffort;
  mode?: RunMode;
  target?: RunTarget;
}

interface RequiredRunControlOptions {
  effort: RunEffort;
  mode: RunMode;
  target: RunTarget;
}

interface RunInputs {
  entrypoint?: string;
  pipelineRunner?: typeof runPipelineFromConfig;
  runControl?: RunControlOptions;
  runId?: string;
  runStoreMode?: RunStoreMode;
  schedule?: string;
  // PIPE-91.16: serialized schedule artifact (schedule.yaml content) for the run.
  // Persisted at createRun so `moka resume` rebuilds this exact graph.
  scheduleArtifact?: string;
  supervised?: boolean;
  supervisor?: boolean;
  task: string;
  workflow?: string;
  worktreePath: string;
}

/**
 * Config-driven `execute` entrypoint. Package-owned defaults are the source of
 * truth; repo-local pipeline files are ignored by runtime loading.
 */
export function execute(
  description: string,
  options: ExecuteOptions = {}
): Promise<void> {
  try {
    if (!description.trim()) {
      throw new Error("Task description is required");
    }

    const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    return runConfiguredPipeline({
      entrypoint: options.entrypoint,
      pipelineRunner: options.pipelineRunner,
      runControl: options.runControl,
      runId: options.runId,
      runStoreMode: options.runStoreMode,
      schedule: options.schedule,
      supervised: options.supervised,
      supervisor: options.supervisor,
      task: description,
      workflow: options.workflow,
      worktreePath,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

export function quick(
  description: string,
  options: Omit<ExecuteOptions, "entrypoint"> = {}
): Promise<void> {
  return execute(description, {
    ...options,
    entrypoint: "quick",
    runControl: { ...options.runControl, effort: "quick" },
  });
}

export function runLocalResolvedTask(
  task: string,
  execution: LocalRuntimeExecution,
  runControl: RunControlOptions
): Promise<void> {
  return execute(task, {
    entrypoint: execution.entrypoint,
    runControl,
    schedule: execution.schedule,
    supervised: true,
    workflow: execution.workflow,
  });
}

export async function runDetachedResolvedTask(
  task: string,
  execution: LocalRuntimeExecution,
  runControl: RunControlOptions
): Promise<void> {
  const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const runId = generateRuntimeRunId();
  const config = loadPipelineConfig(worktreePath, {
    allowMissingLintFileReferences: true,
  });
  const prepared = await prepareDetachedRun({
    config,
    execution,
    runId,
    task,
    worktreePath,
  });

  await persistDetachedRunController({
    prepared,
    runControl,
    runId,
    task,
    worktreePath,
  });
  console.log(formatDetachedRunFollowUp(runId));
}

function persistDetachedRunController(input: {
  prepared: PreparedDetachedRun;
  runControl: RunControlOptions;
  runId: string;
  task: string;
  worktreePath: string;
}): Promise<void> {
  return Effect.runPromise(
    withRunControlStoreScoped(input.worktreePath, (store) =>
      Effect.gen(function* () {
        yield* store.createRun(detachedRunRecord(input));
        const launch = yield* Effect.tryPromise({
          catch: (error) => error,
          try: () =>
            startDetachedRunController(detachedRunControllerInput(input)),
        });
        yield* store.updateRunController({
          controller: {
            argv: launch.argv,
            cwd: input.worktreePath,
            paths: store.statusPaths({ runId: input.runId }),
            pid: launch.pid,
            startedAt: launch.startedAt,
          },
          runId: input.runId,
        });
      })
    )
  );
}

function detachedRunControllerInput(input: {
  prepared: PreparedDetachedRun;
  runId: string;
  task: string;
  worktreePath: string;
}): StartDetachedRunControllerInput {
  return {
    entrypoint: input.prepared.entrypoint,
    runId: input.runId,
    ...(input.prepared.schedule ? { schedule: input.prepared.schedule } : {}),
    task: input.task,
    workflow: input.prepared.workflow,
    workspaceRoot: input.worktreePath,
  };
}

function detachedRunRecord(input: {
  prepared: PreparedDetachedRun;
  runControl: RunControlOptions;
  runId: string;
  task: string;
  worktreePath: string;
}): Parameters<RunControlStore["createRun"]>[0] {
  return {
    ...resolvedRunControlOptions(input.runControl),
    nodeIds: plannedRunStoreNodeIds({
      config: input.prepared.config,
      entrypoint: input.prepared.entrypoint,
      runId: input.runId,
      runControl: input.runControl,
      schedule: input.prepared.schedule,
      task: input.task,
      workflow: input.prepared.workflow,
      worktreePath: input.worktreePath,
    }),
    runId: input.runId,
    ...(input.prepared.scheduleArtifact
      ? { schedule: input.prepared.scheduleArtifact }
      : {}),
  };
}

function withRunId(inputs: RunInputs): RunInputs {
  return { ...inputs, runId: inputs.runId ?? generateRuntimeRunId() };
}

async function runConfiguredPipeline(rawInputs: RunInputs): Promise<void> {
  const inputs = withRunId(rawInputs);
  const config = loadPipelineConfig(inputs.worktreePath, {
    allowMissingLintFileReferences: true,
  });
  if (inputs.schedule) {
    const scheduleYaml = readFileSync(inputs.schedule, "utf8");
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(scheduleYaml, inputs.schedule),
      inputs.worktreePath
    );
    await runAndPrintPipeline({
      ...inputs,
      config: compiled.config,
      scheduleArtifact: scheduleYaml,
      workflow: compiled.workflowId,
    });
    return;
  }

  const scheduledEntrypoint = scheduledEntrypointId(
    config,
    inputs.workflow,
    inputs.entrypoint
  );
  if (scheduledEntrypoint) {
    if (inputs.pipelineRunner) {
      await runAndPrintPipeline({ ...inputs, config });
      return;
    }
    const result = await generateScheduleArtifactInMemory({
      config,
      entrypointId: scheduledEntrypoint,
      runId: inputs.runId,
      task: inputs.task,
      worktreePath: inputs.worktreePath,
    });
    console.log("Schedule generated in memory");
    const scheduleYaml = result.yaml;
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(scheduleYaml, "schedule.yaml"),
      inputs.worktreePath
    );
    await runAndPrintPipeline({
      ...inputs,
      config: compiled.config,
      scheduleArtifact: scheduleYaml,
      workflow: compiled.workflowId,
    });
    return;
  }

  await runAndPrintPipeline({ ...inputs, config });
}

async function runAndPrintPipeline(
  inputs: RunInputs & { config: PipelineConfig }
): Promise<void> {
  await Effect.runPromise(
    withRunControlStoreScoped(inputs.worktreePath, (store) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: () => runAndPrintPipelineWithStore(inputs, store),
      })
    )
  );
}

async function runAndPrintPipelineWithStore(
  inputs: RunInputs & { config: PipelineConfig },
  store: RunControlStore
): Promise<void> {
  const runner = inputs.pipelineRunner ?? runPipelineFromConfig;
  const terminalReporter = createTerminalRuntimeReporter();
  const runStoreReporter = await createRunStoreReporter(
    inputs,
    terminalReporter,
    store
  );
  printSupervisedFollowUp(inputs);
  const result = await runPipelineSafely(inputs, runner, runStoreReporter);
  console.log(formatRuntimeResult(result));
  if (result.outcome !== "PASS") {
    throw new Error(formatRuntimeFailureWithFollowUp(result, inputs));
  }
}

function printSupervisedFollowUp(inputs: RunInputs): void {
  if (inputs.supervised) {
    console.log(formatSupervisedRunFollowUp(requireRunId(inputs.runId)));
  }
}

function runPipelineSafely(
  inputs: RunInputs & { config: PipelineConfig },
  runner: typeof runPipelineFromConfig,
  runStoreReporter: Awaited<ReturnType<typeof createRunStoreReporter>>
): Promise<Awaited<ReturnType<typeof runPipelineFromConfig>>> {
  return runWithFlushedReporter(runStoreReporter.flush, () =>
    runner({
      config: inputs.config,
      entrypoint: inputs.entrypoint,
      reporter: runStoreReporter.reporter,
      runId: inputs.runId,
      task: inputs.task,
      workflowId: inputs.workflow,
      worktreePath: inputs.worktreePath,
    })
  ).catch((error) => {
    throw runtimeErrorWithFollowUp(error, inputs);
  });
}

async function runWithFlushedReporter<T>(
  flush: () => Promise<void>,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } finally {
    await flush();
  }
}

async function createLocalRunStoreRuntimeReporter(
  inputs: RunInputs & { config: PipelineConfig },
  reporter: NonNullable<
    Parameters<typeof createRunStoreRuntimeReporter>[0]["reporter"]
  >,
  store: RunControlStore
) {
  const runId = requireRunId(inputs.runId);
  await Effect.runPromise(
    store.createRun({
      ...resolvedRunControlOptions(inputs.runControl),
      nodeIds: plannedRunStoreNodeIds(inputs),
      runId,
      ...(inputs.scheduleArtifact ? { schedule: inputs.scheduleArtifact } : {}),
    })
  );

  return createRunStoreRuntimeReporter({
    reporter,
    runId,
    store,
    workspaceRoot: inputs.worktreePath,
  });
}

function createRunStoreReporter(
  inputs: RunInputs & { config: PipelineConfig },
  reporter: NonNullable<
    Parameters<typeof createRunStoreRuntimeReporter>[0]["reporter"]
  >,
  store: RunControlStore
) {
  if (inputs.runStoreMode === "reuse") {
    const runId = requireRunId(inputs.runId);
    if (inputs.supervisor) {
      const supervisor = createRunControlSupervisor({
        reporter,
        runId,
        store,
        workspaceRoot: inputs.worktreePath,
      });
      supervisor.start();
      return {
        flush: supervisor.stop,
        reporter: supervisor.reporter,
      };
    }
    return createRunStoreRuntimeReporter({
      reporter,
      runId,
      store,
      workspaceRoot: inputs.worktreePath,
    });
  }

  return createLocalRunStoreRuntimeReporter(inputs, reporter, store);
}

function requireRunId(runId: string | undefined): string {
  if (!runId) {
    throw new Error("Run id is required for local run-control persistence.");
  }
  return runId;
}

function resolvedRunControlOptions(
  input: RunControlOptions | undefined
): RequiredRunControlOptions {
  return { ...DEFAULT_RUN_CONTROL_OPTIONS, ...input };
}

const DEFAULT_RUN_CONTROL_OPTIONS: RequiredRunControlOptions = {
  effort: "normal",
  mode: "write",
  target: "local",
};

function plannedRunStoreNodeIds(
  inputs: RunInputs & { config: PipelineConfig }
): string[] {
  if (inputs.pipelineRunner) {
    return [];
  }
  const workflowId = resolveWorkflowSelection(
    inputs.config,
    inputs.workflow,
    inputs.entrypoint
  );
  const plan = compileWorkflowPlan(inputs.config, workflowId);
  return flattenNodes(plan.topologicalOrder, (node) => node.children).map(
    (node) => node.id
  );
}

function formatSupervisedRunFollowUp(runId: string): string {
  return [
    `Run id: ${runId}`,
    `Status: moka status ${runId}`,
    `Logs: moka logs ${runId}`,
  ].join("\n");
}

function formatDetachedRunFollowUp(runId: string): string {
  return [
    `Run id: ${runId}`,
    `Status: moka status ${runId}`,
    `Logs: moka logs ${runId}`,
    `Stop: moka stop ${runId}`,
  ].join("\n");
}

function formatRuntimeFailureWithFollowUp(
  result: Parameters<typeof formatRuntimeFailure>[0],
  inputs: RunInputs
): string {
  const message = formatRuntimeFailure(result);
  if (!(inputs.supervised && inputs.runId)) {
    return message;
  }

  return [message, "", formatSupervisedRunFollowUp(inputs.runId)].join("\n");
}

function runtimeErrorWithFollowUp(error: unknown, inputs: RunInputs): unknown {
  if (!(inputs.supervised && inputs.runId)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    [message, "", formatSupervisedRunFollowUp(inputs.runId)].join("\n")
  );
}

function scheduledEntrypointId(
  config: PipelineConfig,
  workflowId: string | undefined,
  entrypointId: string | undefined
): string | null {
  return workflowId
    ? null
    : scheduledEntrypointById(config, entrypointId ?? "execute");
}

function scheduledEntrypointById(
  config: PipelineConfig,
  id: string
): string | null {
  const entrypoint = config.entrypoints[id];
  return entrypoint && "schedule" in entrypoint ? id : null;
}

interface PrepareDetachedRunInput {
  config: PipelineConfig;
  execution: LocalRuntimeExecution;
  runId: string;
  task: string;
  worktreePath: string;
}

interface PreparedDetachedRun {
  config: PipelineConfig;
  entrypoint?: string;
  schedule?: string;
  scheduleArtifact?: string;
  workflow?: string;
}

async function prepareDetachedRun(
  input: PrepareDetachedRunInput
): Promise<PreparedDetachedRun> {
  if (input.execution.schedule) {
    const schedule = resolve(input.execution.schedule);
    const scheduleYaml = readFileSync(schedule, "utf8");
    const compiled = compileScheduleArtifact(
      input.config,
      parseScheduleArtifact(scheduleYaml, schedule),
      input.worktreePath
    );
    return {
      config: compiled.config,
      schedule,
      scheduleArtifact: scheduleYaml,
      workflow: compiled.workflowId,
    };
  }

  const scheduledEntrypoint = scheduledEntrypointId(
    input.config,
    input.execution.workflow,
    input.execution.entrypoint
  );
  if (!scheduledEntrypoint) {
    return {
      config: input.config,
      entrypoint: input.execution.entrypoint,
      workflow: input.execution.workflow,
    };
  }

  const result = await generateScheduleArtifactInMemory({
    config: input.config,
    entrypointId: scheduledEntrypoint,
    runId: input.runId,
    task: input.task,
    worktreePath: input.worktreePath,
  });
  console.log("Schedule generated in memory");
  const scheduleYaml = result.yaml;
  const compiled = compileScheduleArtifact(
    input.config,
    parseScheduleArtifact(scheduleYaml, "schedule.yaml"),
    input.worktreePath
  );
  return {
    config: compiled.config,
    scheduleArtifact: scheduleYaml,
    workflow: compiled.workflowId,
  };
}
