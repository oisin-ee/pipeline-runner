import { Option } from "commander";
import type { Command } from "commander";

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
  globalThis.console.log(message);
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

export const registerRunCommands = (
  program: Command,
  options: RegisterRunCommandsOptions = {}
): RunCommand => {
  const dispatchResolvedRunCommand = createResolvedRunCommand(options);
  program
    .command("run")
    .description(
      "Primary command: run a workflow from package-owned @oisincoveney/pipeline config"
    )
    .argument("<description...>", "task description")
    .option(
      "--command",
      "treat input after -- as explicit argv for remote submission"
    )
    .option("--entrypoint <entrypoint>", "entrypoint id from package config")
    .option(
      "--detach",
      "start a supervised controller process in the background"
    )
    .addOption(
      new Option("--effort <effort>", "run effort")
        .choices([...MOKA_RUN_EFFORTS])
        .default("normal")
    )
    .option("--read-only", "run the read-only inspect workflow")
    .option("--schedule <schedule>", "approved schedule YAML to execute")
    .addOption(
      new Option("--target <target>", "execution target")
        .choices([...MOKA_RUN_TARGETS])
        .default("local")
    )
    .option("--workflow <workflow>", "workflow id from package config")
    .action(async (descriptionParts: string[], flags: RunFlags) => {
      const task = descriptionParts.join(" ");
      const resolution = resolveMokaRun({ flags, task });
      await dispatchResolvedRunCommand({
        descriptionParts,
        flags,
        resolution,
        task,
      });
    });

  program
    .command("run-controller", { hidden: true })
    .description("Internal detached run controller")
    .argument("<description...>", "task description")
    .requiredOption("--run-id <run-id>", "existing run id to supervise")
    .option("--entrypoint <entrypoint>", "entrypoint id from package config")
    .option("--schedule <schedule>", "approved schedule YAML to execute")
    .option("--workflow <workflow>", "workflow id from package config")
    .action(async (descriptionParts: string[], flags: RunControllerFlags) => {
      await execute(descriptionParts.join(" "), {
        entrypoint: flags.entrypoint,
        runId: flags.runId,
        runStoreMode: "reuse",
        schedule: flags.schedule,
        supervised: true,
        supervisor: true,
        workflow: flags.workflow,
      });
    });

  return dispatchResolvedRunCommand;
};
