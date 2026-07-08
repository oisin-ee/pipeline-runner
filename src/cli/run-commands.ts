import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { decodeLiteralCliArgs, literalArgFlagName } from "./cli-args";
import { writeTerminalLog } from "./format";
import { dispatchMokaRunCommand } from "./run-command";
import type { RunCommand } from "./run-command";
import {
  MOKA_RUN_EFFORTS,
  MOKA_RUN_TARGETS,
  resolveMokaRun,
} from "./run-resolver";
import type { RemoteSubmitExecution, RunResolverFlags } from "./run-resolver";
import {
  execute,
  runDetachedResolvedTask,
  runLocalResolvedTask,
} from "./run-service";
import { runMokaSubmitFromCli } from "./submit-options";
import type { MokaSubmitFlags } from "./submit-options";

type RunFlags = RunResolverFlags;

interface RunControllerFlags {
  entrypoint?: string;
  runId: string;
  schedule?: string;
  workflow?: string;
}

export interface RegisterRunCommandsOptions {
  readonly runCommand?: RunCommand;
}

const runCommandFlags = {
  command: Flag.boolean("command").pipe(
    Flag.withDescription(
      "treat input after -- as explicit argv for remote submission"
    )
  ),
  descriptionParts: Argument.string("description").pipe(
    Argument.withDescription("task description"),
    Argument.variadic({ min: 0 })
  ),
  detach: Flag.boolean("detach").pipe(
    Flag.withDescription(
      "start a supervised controller process in the background"
    )
  ),
  effort: Flag.choice("effort", MOKA_RUN_EFFORTS).pipe(
    Flag.withDescription("run effort"),
    Flag.withDefault(MOKA_RUN_EFFORTS[0])
  ),
  entrypoint: Flag.string("entrypoint").pipe(
    Flag.withDescription("entrypoint id from package config"),
    Flag.optional
  ),
  literalArgs: Flag.string(literalArgFlagName).pipe(
    Flag.withDescription("internal preserved command argv"),
    Flag.withHidden,
    Flag.atLeast(0)
  ),
  readOnly: Flag.boolean("read-only").pipe(
    Flag.withDescription("run the read-only inspect workflow")
  ),
  schedule: Flag.string("schedule").pipe(
    Flag.withDescription("approved schedule YAML to execute"),
    Flag.optional
  ),
  target: Flag.choice("target", MOKA_RUN_TARGETS).pipe(
    Flag.withDescription("execution target"),
    Flag.withDefault(MOKA_RUN_TARGETS[0])
  ),
  workflow: Flag.string("workflow").pipe(
    Flag.withDescription("workflow id from package config"),
    Flag.optional
  ),
};

const runControllerFlags = {
  descriptionParts: runCommandFlags.descriptionParts,
  entrypoint: runCommandFlags.entrypoint,
  runId: Flag.string("run-id").pipe(
    Flag.withDescription("existing run id to supervise")
  ),
  schedule: runCommandFlags.schedule,
  workflow: runCommandFlags.workflow,
};

const normalizeRunFlags = (
  flags: Command.Command.Config.Infer<typeof runCommandFlags>
): {
  readonly descriptionParts: string[];
  readonly flags: RunFlags;
} => ({
  descriptionParts:
    flags.literalArgs.length > 0
      ? decodeLiteralCliArgs(flags.literalArgs)
      : [...flags.descriptionParts],
  flags: {
    command: flags.command,
    detach: flags.detach,
    effort: flags.effort,
    entrypoint: Option.getOrUndefined(flags.entrypoint),
    readOnly: flags.readOnly,
    schedule: Option.getOrUndefined(flags.schedule),
    target: flags.target,
    workflow: Option.getOrUndefined(flags.workflow),
  },
});

const normalizeRunControllerFlags = (
  flags: Command.Command.Config.Infer<typeof runControllerFlags>
): {
  readonly descriptionParts: string[];
  readonly flags: RunControllerFlags;
} => ({
  descriptionParts: [...flags.descriptionParts],
  flags: {
    entrypoint: Option.getOrUndefined(flags.entrypoint),
    runId: flags.runId,
    schedule: Option.getOrUndefined(flags.schedule),
    workflow: Option.getOrUndefined(flags.workflow),
  },
});

const remoteSubmitFlags = (
  execution: RemoteSubmitExecution
): MokaSubmitFlags => ({
  command: execution.command,
  quick: execution.mode === "quick",
  schedule: execution.schedule,
});

export const printMokaSubmitResult = (
  result: Awaited<ReturnType<typeof runMokaSubmitFromCli>>
): void => {
  const message = [
    `Submitted Argo Workflow: ${result.namespace}/${result.workflowName}`,
    result.workflowUid !== undefined && result.workflowUid !== ""
      ? `uid=${result.workflowUid}`
      : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  writeTerminalLog(message);
};

const createResolvedRunCommand =
  (options: RegisterRunCommandsOptions): RunCommand =>
  async (call) => {
    await dispatchMokaRunCommand(call, {
      runCommand: options.runCommand,
      runDetached: async ({ execution, runControl, task: resolvedTask }) => {
        await runDetachedResolvedTask(resolvedTask, execution, runControl);
      },
      runLocal: async ({ execution, runControl, task: resolvedTask }) => {
        await runLocalResolvedTask(resolvedTask, execution, runControl);
      },
      runRemoteSubmit: async ({ descriptionParts: parts, execution }) => {
        const result = await runMokaSubmitFromCli(
          parts,
          remoteSubmitFlags(execution)
        );
        printMokaSubmitResult(result);
      },
    });
  };

export const createRunCommands = (options: RegisterRunCommandsOptions = {}) => {
  const dispatchResolvedRunCommand = createResolvedRunCommand(options);
  const runCommand = Command.make("run", runCommandFlags, (rawFlags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const { descriptionParts, flags } = normalizeRunFlags(rawFlags);
        const task = descriptionParts.join(" ");
        const resolution = resolveMokaRun({ flags, task });
        await dispatchResolvedRunCommand({
          descriptionParts,
          flags,
          resolution,
          task,
        });
      },
    })
  ).pipe(
    Command.withDescription(
      "Primary command: run a workflow from package-owned @oisincoveney/pipeline config"
    )
  );
  const runControllerCommand = Command.make(
    "run-controller",
    runControllerFlags,
    (rawFlags) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          const { descriptionParts, flags } =
            normalizeRunControllerFlags(rawFlags);
          await execute(descriptionParts.join(" "), {
            entrypoint: flags.entrypoint,
            runId: flags.runId,
            runStoreMode: "reuse",
            schedule: flags.schedule,
            supervised: true,
            supervisor: true,
            workflow: flags.workflow,
          });
        },
      })
  ).pipe(
    Command.withDescription("Internal detached run controller"),
    Command.withHidden
  );

  return {
    commands: [runCommand, runControllerCommand],
    runCommand: dispatchResolvedRunCommand,
  };
};
