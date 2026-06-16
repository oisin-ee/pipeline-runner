import type { Command } from "commander";
import { Context, Effect, Layer } from "effect";
import { runRunnerFinalize } from "../runner-command/finalize";
import { runRunnerLifecycle } from "../runner-command/lifecycle";
import { runRunnerCommand } from "../runner-command/run";

interface RunnerCommandOptions {
  payloadFile: string;
  scheduleFile: string;
}

interface RunnerLifecycleOptions extends RunnerCommandOptions {
  phase: "workflow.start";
}

interface RunnerFinalizeOptions extends RunnerCommandOptions {
  argoStatus: string;
}

class RunnerCommandService extends Context.Tag("RunnerCommandService")<
  RunnerCommandService,
  {
    readonly finalize: (
      options: RunnerFinalizeOptions
    ) => Effect.Effect<number, unknown>;
    readonly lifecycle: (
      options: RunnerLifecycleOptions
    ) => Effect.Effect<number, unknown>;
    readonly run: (
      options: RunnerCommandOptions
    ) => Effect.Effect<number, unknown>;
  }
>() {}

const RunnerCommandServiceLive = Layer.succeed(RunnerCommandService, {
  finalize: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => runRunnerFinalize(options),
    }),
  lifecycle: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => runRunnerLifecycle(options),
    }),
  run: (options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => runRunnerCommand(options),
    }),
});

const setProcessExitCode = (exitCode: number) =>
  Effect.sync(() => {
    process.exitCode = exitCode;
  });

const runRunnerCommandEffect = (options: RunnerCommandOptions) =>
  Effect.gen(function* () {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.run(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerLifecycleEffect = (options: RunnerLifecycleOptions) =>
  Effect.gen(function* () {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.lifecycle(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerFinalizeEffect = (options: RunnerFinalizeOptions) =>
  Effect.gen(function* () {
    const service = yield* RunnerCommandService;
    const exitCode = yield* service.finalize(options);
    yield* setProcessExitCode(exitCode);
  });

const runRunnerProgram = <A>(
  program: Effect.Effect<A, unknown, RunnerCommandService>
) => Effect.runPromise(Effect.provide(program, RunnerCommandServiceLive));

export function registerRunnerCommandCommand(program: Command): void {
  program
    .command("runner-command")
    .description("Run one scheduled Argo Workflow task")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption(
      "--schedule-file <path>",
      "Path to the schedule artifact YAML"
    )
    .action((options: RunnerCommandOptions) =>
      runRunnerProgram(runRunnerCommandEffect(options))
    );

  program
    .command("runner-lifecycle")
    .description("Run one Argo Workflow lifecycle phase")
    .requiredOption("--phase <phase>", "Lifecycle phase to run")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption(
      "--schedule-file <path>",
      "Path to the schedule artifact YAML"
    )
    .action((options: RunnerLifecycleOptions) =>
      runRunnerProgram(runRunnerLifecycleEffect(options))
    );

  program
    .command("runner-finalize")
    .description("Finalize one Argo Workflow run")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .requiredOption(
      "--schedule-file <path>",
      "Path to the schedule artifact YAML"
    )
    .requiredOption("--argo-status <status>", "Argo Workflow status")
    .action((options: RunnerFinalizeOptions) =>
      runRunnerProgram(runRunnerFinalizeEffect(options))
    );
}
