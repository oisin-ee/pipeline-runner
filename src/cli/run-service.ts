import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Effect } from "effect";
import * as Console from "effect/Console";

import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import { runPipelineFromConfig } from "../pipeline-runtime";
import { compileWorkflowPlan } from "../planning/compile";
import {
  compileScheduleArtifact,
  generateScheduleArtifactInMemory,
  parseScheduleArtifact,
} from "../planning/generate";
import { flattenNodes } from "../planning/graph";
import type { RunEffort, RunMode, RunTarget } from "../run-control/contracts";
import { startDetachedRunController } from "../run-control/detach";
import type { StartDetachedRunControllerInput } from "../run-control/detach";
import { withRunControlStoreScoped } from "../run-control/run-control-store";
import type { RunControlStore } from "../run-control/run-control-store";
import { createRunStoreRuntimeReporter } from "../run-control/runtime-reporter";
import { createRunControlSupervisor } from "../run-control/supervisor";
import {
  generateRuntimeRunId,
  resolveWorkflowSelection,
} from "../runtime/context";
import { createTerminalRuntimeReporter, formatRuntimeFailure } from "./format";
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

const detachedRunControllerInput = (input: {
  prepared: PreparedDetachedRun;
  runId: string;
  task: string;
  worktreePath: string;
}): StartDetachedRunControllerInput => ({
  entrypoint: input.prepared.entrypoint,
  runId: input.runId,
  ...(input.prepared.schedule !== undefined && input.prepared.schedule !== ""
    ? { schedule: input.prepared.schedule }
    : {}),
  task: input.task,
  workflow: input.prepared.workflow,
  workspaceRoot: input.worktreePath,
});

const withRunId = (inputs: RunInputs): RunInputs => ({
  ...inputs,
  runId: inputs.runId ?? generateRuntimeRunId(),
});

const runWithFlushedReporter = async <T>(
  flush: () => Promise<void>,
  run: () => Promise<T>
): Promise<T> => {
  try {
    return await run();
  } finally {
    await flush();
  }
};

const requireRunId = (runId = ""): string => {
  if (runId === "") {
    throw new Error("Run id is required for local run-control persistence.");
  }
  return runId;
};

const DEFAULT_RUN_CONTROL_OPTIONS: RequiredRunControlOptions = {
  effort: "normal",
  mode: "write",
  target: "local",
};

const resolvedRunControlOptions = (
  input: RunControlOptions = {}
): RequiredRunControlOptions => ({
  ...DEFAULT_RUN_CONTROL_OPTIONS,
  ...input,
});

const plannedRunStoreNodeIds = (
  inputs: RunInputs & { config: PipelineConfig }
): string[] => {
  if (inputs.pipelineRunner !== undefined) {
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
};

const detachedRunRecord = (input: {
  prepared: PreparedDetachedRun;
  runControl: RunControlOptions;
  runId: string;
  task: string;
  worktreePath: string;
}): Parameters<RunControlStore["createRun"]>[0] => ({
  ...resolvedRunControlOptions(input.runControl),
  nodeIds: plannedRunStoreNodeIds({
    config: input.prepared.config,
    entrypoint: input.prepared.entrypoint,
    runControl: input.runControl,
    runId: input.runId,
    schedule: input.prepared.schedule,
    task: input.task,
    workflow: input.prepared.workflow,
    worktreePath: input.worktreePath,
  }),
  runId: input.runId,
  ...(input.prepared.scheduleArtifact !== undefined &&
  input.prepared.scheduleArtifact !== ""
    ? { schedule: input.prepared.scheduleArtifact }
    : {}),
});

const persistDetachedRunController = async (input: {
  prepared: PreparedDetachedRun;
  runControl: RunControlOptions;
  runId: string;
  task: string;
  worktreePath: string;
}): Promise<void> => {
  await Effect.runPromise(
    withRunControlStoreScoped(input.worktreePath, (store) =>
      Effect.gen(function* effectBody() {
        yield* store.createRun(detachedRunRecord(input));
        const launch = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await startDetachedRunController(detachedRunControllerInput(input)),
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
};

const formatSupervisedRunFollowUp = (runId: string): string =>
  [
    `Run id: ${runId}`,
    `Status: moka status ${runId}`,
    `Logs: moka logs ${runId}`,
  ].join("\n");

const writeSupervisedFollowUpEffect = (
  inputs: RunInputs
): Effect.Effect<void> => {
  if (!(inputs.supervised === true && inputs.runId !== undefined)) {
    return Effect.void;
  }
  return Console.error(formatSupervisedRunFollowUp(inputs.runId)).pipe(
    Effect.provideService(Console.Console, globalThis.console)
  );
};

const createLocalRunStoreRuntimeReporter = async (
  inputs: RunInputs & { config: PipelineConfig },
  reporter: NonNullable<
    Parameters<typeof createRunStoreRuntimeReporter>[0]["reporter"]
  >,
  store: RunControlStore
) => {
  const runId = requireRunId(inputs.runId);
  await Effect.runPromise(
    Effect.gen(function* effectBody() {
      yield* store.createRun({
        ...resolvedRunControlOptions(inputs.runControl),
        nodeIds: plannedRunStoreNodeIds(inputs),
        runId,
        ...(inputs.scheduleArtifact !== undefined &&
        inputs.scheduleArtifact !== ""
          ? { schedule: inputs.scheduleArtifact }
          : {}),
      });
      yield* writeSupervisedFollowUpEffect(inputs);
    })
  );

  return createRunStoreRuntimeReporter({
    reporter,
    runId,
    store,
    workspaceRoot: inputs.worktreePath,
  });
};

const createRunStoreReporter = async (
  inputs: RunInputs & { config: PipelineConfig },
  reporter: NonNullable<
    Parameters<typeof createRunStoreRuntimeReporter>[0]["reporter"]
  >,
  store: RunControlStore
) => {
  if (inputs.runStoreMode === "reuse") {
    const runId = requireRunId(inputs.runId);
    if (inputs.supervisor === true) {
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

  return await createLocalRunStoreRuntimeReporter(inputs, reporter, store);
};

const formatRuntimeFailureWithFollowUp = (
  result: Parameters<typeof formatRuntimeFailure>[0],
  inputs: RunInputs
): string => {
  const message = formatRuntimeFailure(result);
  if (!(inputs.supervised === true && inputs.runId !== undefined)) {
    return message;
  }

  return [message, "", formatSupervisedRunFollowUp(inputs.runId)].join("\n");
};

const runtimeErrorWithFollowUp = (
  error: unknown,
  inputs: RunInputs
): unknown => {
  if (!(inputs.supervised === true && inputs.runId !== undefined)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    [message, "", formatSupervisedRunFollowUp(inputs.runId)].join("\n")
  );
};

const runPipelineSafely = async (
  inputs: RunInputs & { config: PipelineConfig },
  runner: typeof runPipelineFromConfig,
  runStoreReporter: Awaited<ReturnType<typeof createRunStoreReporter>>
): Promise<Awaited<ReturnType<typeof runPipelineFromConfig>>> =>
  await runWithFlushedReporter(
    runStoreReporter.flush,
    async () =>
      await runner({
        config: inputs.config,
        entrypoint: inputs.entrypoint,
        reporter: runStoreReporter.reporter,
        runId: inputs.runId,
        task: inputs.task,
        workflowId: inputs.workflow,
        worktreePath: inputs.worktreePath,
      })
  ).catch((error: unknown) => {
    throw runtimeErrorWithFollowUp(error, inputs);
  });

const runAndPrintPipelineWithStore = async (
  inputs: RunInputs & { config: PipelineConfig },
  store: RunControlStore
): Promise<void> => {
  const runner = inputs.pipelineRunner ?? runPipelineFromConfig;
  const terminalReporter = createTerminalRuntimeReporter((message) => {
    globalThis.console.error(message);
  });
  const runStoreReporter = await createRunStoreReporter(
    inputs,
    terminalReporter,
    store
  );
  const result = await runPipelineSafely(inputs, runner, runStoreReporter);

  if (result.outcome !== "PASS") {
    throw new Error(formatRuntimeFailureWithFollowUp(result, inputs));
  }
};

const runAndPrintPipeline = async (
  inputs: RunInputs & { config: PipelineConfig }
): Promise<void> => {
  await Effect.runPromise(
    withRunControlStoreScoped(inputs.worktreePath, (store) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await runAndPrintPipelineWithStore(inputs, store);
        },
      })
    )
  );
};

const scheduledEntrypointById = (
  config: PipelineConfig,
  id: string
): string => {
  if (!Object.hasOwn(config.entrypoints, id)) {
    return "";
  }
  const entrypoint = config.entrypoints[id];
  return "schedule" in entrypoint ? id : "";
};

const scheduledEntrypointId = (
  config: PipelineConfig,
  workflowId?: string,
  entrypointId?: string
): string =>
  workflowId !== undefined && workflowId !== ""
    ? ""
    : scheduledEntrypointById(config, entrypointId ?? "execute");

const runConfiguredPipeline = async (rawInputs: RunInputs): Promise<void> => {
  const inputs = withRunId(rawInputs);
  const config = loadPipelineConfig(inputs.worktreePath, {
    allowMissingLintFileReferences: true,
  });
  if (inputs.schedule !== undefined && inputs.schedule !== "") {
    const scheduleYaml = readFileSync(inputs.schedule, "utf-8");
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
  if (scheduledEntrypoint !== "") {
    if (inputs.pipelineRunner !== undefined) {
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
};

/**
 * Config-driven `execute` entrypoint. Package-owned defaults are the source of
 * truth; repo-local pipeline files are ignored by runtime loading.
 */
export const execute = async (
  description: string,
  options: ExecuteOptions = {}
): Promise<void> => {
  if (!description.trim()) {
    throw new Error("Task description is required");
  }

  const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  await runConfiguredPipeline({
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
};

export const quick = async (
  description: string,
  options: Omit<ExecuteOptions, "entrypoint"> = {}
): Promise<void> => {
  await execute(description, {
    ...options,
    entrypoint: "quick",
    runControl: { ...options.runControl, effort: "quick" },
  });
};

export const runLocalResolvedTask = async (
  task: string,
  execution: LocalRuntimeExecution,
  runControl: RunControlOptions
): Promise<void> => {
  await execute(task, {
    entrypoint: execution.entrypoint,
    runControl,
    schedule: execution.schedule,
    supervised: true,
    workflow: execution.workflow,
  });
};

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

const prepareDetachedRun = async (
  input: PrepareDetachedRunInput
): Promise<PreparedDetachedRun> => {
  if (
    input.execution.schedule !== undefined &&
    input.execution.schedule !== ""
  ) {
    const schedule = resolve(input.execution.schedule);
    const scheduleYaml = readFileSync(schedule, "utf-8");
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
  if (scheduledEntrypoint === "") {
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
};

export const runDetachedResolvedTask = async (
  task: string,
  execution: LocalRuntimeExecution,
  runControl: RunControlOptions
): Promise<void> => {
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
};
