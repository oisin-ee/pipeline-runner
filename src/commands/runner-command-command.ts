import type { Command } from "commander";
import { Context, Effect, Layer } from "effect";

import { runRunnerFinalize } from "../runner-command/finalize";
import { runRunnerLifecycle } from "../runner-command/lifecycle";
import { runPreSchedulePhase } from "../runner-command/pre-schedule";
import type { PreSchedulePhase } from "../runner-command/pre-schedule";
import { runRunnerCommand } from "../runner-command/run";
import { runSelectReadyWave } from "../runner-command/select-ready-wave";

interface RunnerCommandOptions {
  nodeId?: string;
  payloadFile: string;
  scheduleFile?: string;
  scheduleSource?: "db" | "file";
}

interface RunnerLifecycleOptions extends RunnerCommandOptions {
  phase: "workflow.start";
}

interface RunnerFinalizeOptions extends RunnerCommandOptions {
  argoStatus: string;
}

interface PreScheduleOptions {
  payloadFile: string;
  phase: PreSchedulePhase;
}

class RunnerCommandService extends Context.Service<
  RunnerCommandService,
  {
    readonly finalize: (options: RunnerFinalizeOptions) => Effect.Effect<number, unknown>;
    readonly lifecycle: (options: RunnerLifecycleOptions) => Effect.Effect<number, unknown>;
    readonly preSchedule: (options: PreScheduleOptions) => Effect.Effect<number, unknown>;
    readonly run: (options: RunnerCommandOptions) => Effect.Effect<number, unknown>;
    readonly selectReadyWave: (options: { outputFile: string; payloadFile: string }) => Effect.Effect<number, unknown>;
  }
>()("RunnerCommandService") {}

const RunnerCommandServiceLive = Layer.succeed(RunnerCommandService, {
  finalize: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await runRunnerFinalize(options),
    }),
  lifecycle: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await runRunnerLifecycle(options),
    }),
  preSchedule: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await runPreSchedulePhase(options),
    }),
  run: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await runRunnerCommand(options),
    }),
  selectReadyWave: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await runSelectReadyWave(options),
    }),
});

const setProcessExitCode = (exitCode: number) =>
  Effect.sync(() => {
    process.exitCode = exitCode;
  });

const runRunnerCommandEffect = (options: RunnerCommandOptions) =>
  Effect.gen(function* runRunnerCommandEffect() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.run(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerLifecycleEffect = (options: RunnerLifecycleOptions) =>
  Effect.gen(function* runRunnerLifecycleEffect() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.lifecycle(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerFinalizeEffect = (options: RunnerFinalizeOptions) =>
  Effect.gen(function* runRunnerFinalizeEffect() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.finalize(options);
    yield* setProcessExitCode(exitCode);
  });

const runPreScheduleEffect = (options: PreScheduleOptions) =>
  Effect.gen(function* runPreScheduleEffect() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.preSchedule(options);
    yield* setProcessExitCode(exitCode);
  });

const runSelectReadyWaveEffect = (options: { outputFile: string; payloadFile: string }) =>
  Effect.gen(function* runSelectReadyWaveEffect() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.selectReadyWave(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerProgram = async <A>(program: Effect.Effect<A, unknown, RunnerCommandService>) =>
  await Effect.runPromise(Effect.provide(program, RunnerCommandServiceLive));

export const registerRunnerCommandCommand = (program: Command): void => {
  program
    .command("runner-command")
    .description("Run one scheduled Argo Workflow task")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .option("--node-id <id>", "Node id to execute without a task descriptor")
    .option("--schedule-file <path>", "Path to the schedule artifact YAML")
    .option("--schedule-source <source>", "Schedule source: file or db")
    .action(async (options: RunnerCommandOptions) => {
      await runRunnerProgram(runRunnerCommandEffect(options));
    });

  program
    .command("runner-lifecycle")
    .description("Run one Argo Workflow lifecycle phase")
    .requiredOption("--phase <phase>", "Lifecycle phase to run")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption("--schedule-file <path>", "Path to the schedule artifact YAML")
    .action(async (options: RunnerLifecycleOptions) => {
      await runRunnerProgram(runRunnerLifecycleEffect(options));
    });

  program
    .command("runner-pre-schedule")
    .description("Run one dynamic pre-schedule phase")
    .requiredOption("--phase <phase>", "pre-research, pre-planning, or generate-schedule")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .action(async (options: PreScheduleOptions) => {
      await runRunnerProgram(runPreScheduleEffect(options));
    });

  program
    .command("runner-finalize")
    .description("Finalize one Argo Workflow run")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .option("--schedule-file <path>", "Path to the schedule artifact YAML")
    .option("--schedule-source <source>", "Schedule source: file or db")
    .requiredOption("--argo-status <status>", "Argo Workflow status")
    .option("--argo-failures <json>", "Argo Workflow failure details JSON")
    .action(async (options: RunnerFinalizeOptions) => {
      await runRunnerProgram(runRunnerFinalizeEffect(options));
    });

  program
    .command("runner-select-ready-wave")
    .description("Select DB-ready nodes for the next dynamic Argo wave")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption("--output-file <path>", "Path where the ready node id JSON array is written")
    .action(async (options: { outputFile: string; payloadFile: string }) => {
      await runRunnerProgram(runSelectReadyWaveEffect(options));
    });
};
