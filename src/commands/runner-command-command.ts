import { Context, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

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
  argoFailures?: string;
  argoStatus: string;
}

interface PreScheduleOptions {
  payloadFile: string;
  phase: PreSchedulePhase;
}

const scheduleSourceChoices: readonly ["file", "db"] = ["file", "db"];
const lifecyclePhaseChoices: readonly ["workflow.start"] = ["workflow.start"];
const preSchedulePhaseChoices: readonly [
  "generate-schedule",
  "pre-planning",
  "pre-research",
] = ["generate-schedule", "pre-planning", "pre-research"];

const runnerCommandFlags = {
  nodeId: Flag.string("node-id").pipe(
    Flag.withDescription("Node id to execute without a task descriptor"),
    Flag.optional
  ),
  payloadFile: Flag.string("payload-file").pipe(
    Flag.withDescription("Path to the runner payload JSON")
  ),
  scheduleFile: Flag.string("schedule-file").pipe(
    Flag.withDescription("Path to the schedule artifact YAML"),
    Flag.optional
  ),
  scheduleSource: Flag.choice("schedule-source", scheduleSourceChoices).pipe(
    Flag.withDescription("Schedule source: file or db"),
    Flag.optional
  ),
};

const runnerLifecycleFlags = {
  payloadFile: runnerCommandFlags.payloadFile,
  phase: Flag.choice("phase", lifecyclePhaseChoices).pipe(
    Flag.withDescription("Lifecycle phase to run"),
    Flag.optional
  ),
  scheduleFile: Flag.string("schedule-file").pipe(
    Flag.withDescription("Path to the schedule artifact YAML")
  ),
};

const preScheduleFlags = {
  payloadFile: runnerCommandFlags.payloadFile,
  phase: Flag.choice("phase", preSchedulePhaseChoices).pipe(
    Flag.withDescription("pre-research, pre-planning, or generate-schedule"),
    Flag.optional
  ),
};

const runnerFinalizeFlags = {
  ...runnerCommandFlags,
  argoFailures: Flag.string("argo-failures").pipe(
    Flag.withDescription("Argo Workflow failure details JSON"),
    Flag.optional
  ),
  argoStatus: Flag.string("argo-status").pipe(
    Flag.withDescription("Argo Workflow status")
  ),
};

const selectReadyWaveFlags = {
  outputFile: Flag.string("output-file").pipe(
    Flag.withDescription("Path where the ready node id JSON array is written")
  ),
  payloadFile: runnerCommandFlags.payloadFile,
};

const normalizeRunnerCommandOptions = (
  options: Command.Command.Config.Infer<typeof runnerCommandFlags>
): RunnerCommandOptions => ({
  nodeId: Option.getOrUndefined(options.nodeId),
  payloadFile: options.payloadFile,
  scheduleFile: Option.getOrUndefined(options.scheduleFile),
  scheduleSource: Option.getOrUndefined(options.scheduleSource),
});

const normalizeRunnerLifecycleOptions = (
  options: Command.Command.Config.Infer<typeof runnerLifecycleFlags>
): RunnerLifecycleOptions => ({
  payloadFile: options.payloadFile,
  phase: Option.getOrUndefined(options.phase) ?? "workflow.start",
  scheduleFile: options.scheduleFile,
});

const normalizePreScheduleOptions = (
  options: Command.Command.Config.Infer<typeof preScheduleFlags>
): PreScheduleOptions => ({
  payloadFile: options.payloadFile,
  phase: Option.getOrUndefined(options.phase) ?? "generate-schedule",
});

const normalizeRunnerFinalizeOptions = (
  options: Command.Command.Config.Infer<typeof runnerFinalizeFlags>
): RunnerFinalizeOptions => ({
  ...normalizeRunnerCommandOptions(options),
  argoFailures: Option.getOrUndefined(options.argoFailures),
  argoStatus: options.argoStatus,
});

class RunnerCommandService extends Context.Service<
  RunnerCommandService,
  {
    readonly finalize: (
      options: RunnerFinalizeOptions
    ) => Effect.Effect<number, unknown>;
    readonly lifecycle: (
      options: RunnerLifecycleOptions
    ) => Effect.Effect<number, unknown>;
    readonly preSchedule: (
      options: PreScheduleOptions
    ) => Effect.Effect<number, unknown>;
    readonly run: (
      options: RunnerCommandOptions
    ) => Effect.Effect<number, unknown>;
    readonly selectReadyWave: (options: {
      outputFile: string;
      payloadFile: string;
    }) => Effect.Effect<number, unknown>;
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
  Effect.gen(function* effectBody() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.run(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerLifecycleEffect = (options: RunnerLifecycleOptions) =>
  Effect.gen(function* effectBody() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.lifecycle(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerFinalizeEffect = (options: RunnerFinalizeOptions) =>
  Effect.gen(function* effectBody() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.finalize(options);
    yield* setProcessExitCode(exitCode);
  });

const runPreScheduleEffect = (options: PreScheduleOptions) =>
  Effect.gen(function* effectBody() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.preSchedule(options);
    yield* setProcessExitCode(exitCode);
  });

const runSelectReadyWaveEffect = (options: {
  outputFile: string;
  payloadFile: string;
}) =>
  Effect.gen(function* effectBody() {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.selectReadyWave(options);
    yield* setProcessExitCode(exitCode);
  });

export const createRunnerCommandCommands = () => [
  Command.make("runner-command", runnerCommandFlags, (options) =>
    runRunnerCommandEffect(normalizeRunnerCommandOptions(options))
  ).pipe(
    Command.provide(RunnerCommandServiceLive),
    Command.withDescription("Run one scheduled Argo Workflow task")
  ),
  Command.make("runner-lifecycle", runnerLifecycleFlags, (options) =>
    runRunnerLifecycleEffect(normalizeRunnerLifecycleOptions(options))
  ).pipe(
    Command.provide(RunnerCommandServiceLive),
    Command.withDescription("Run one Argo Workflow lifecycle phase")
  ),
  Command.make("runner-pre-schedule", preScheduleFlags, (options) =>
    runPreScheduleEffect(normalizePreScheduleOptions(options))
  ).pipe(
    Command.provide(RunnerCommandServiceLive),
    Command.withDescription("Run one dynamic pre-schedule phase")
  ),
  Command.make("runner-finalize", runnerFinalizeFlags, (options) =>
    runRunnerFinalizeEffect(normalizeRunnerFinalizeOptions(options))
  ).pipe(
    Command.provide(RunnerCommandServiceLive),
    Command.withDescription("Finalize one Argo Workflow run")
  ),
  Command.make("runner-select-ready-wave", selectReadyWaveFlags, (options) =>
    runSelectReadyWaveEffect(options)
  ).pipe(
    Command.provide(RunnerCommandServiceLive),
    Command.withDescription(
      "Select DB-ready nodes for the next dynamic Argo wave"
    )
  ),
];
