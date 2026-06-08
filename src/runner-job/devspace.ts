import { execa } from "execa";
import { loadPipelineConfig, type PipelineConfig } from "../config.js";

export interface RunnerDevspaceReadiness {
  config: PipelineConfig;
}

export type RunnerDevspaceCommand = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdin: "ignore" }
) => Promise<unknown>;

export function assertRunnerDevspaceReady(
  worktreePath: string
): RunnerDevspaceReadiness {
  return {
    config: loadPipelineConfig(worktreePath, {
      allowMissingLintFileReferences: true,
    }),
  };
}

export async function runRunnerDevspaceSmoke(options: {
  config: PipelineConfig;
  env: Record<string, string | undefined>;
  runCommand?: RunnerDevspaceCommand;
  worktreePath: string;
}): Promise<"ran" | "skipped"> {
  const smoke = options.config.runner_job.environment.smoke;
  if (smoke.length === 0) {
    return "skipped";
  }
  const runCommand = options.runCommand ?? runDevspaceCommand;
  for (const command of smoke) {
    await runCommand(command.command, command.args, {
      cwd: options.worktreePath,
      env: compactEnv(options.env),
      stdin: "ignore",
    });
  }
  return "ran";
}

export async function runRunnerEnvironmentSetup(options: {
  config: PipelineConfig;
  env: Record<string, string | undefined>;
  runCommand?: RunnerDevspaceCommand;
  worktreePath: string;
}): Promise<"ran" | "skipped"> {
  const setup = options.config.runner_job.environment.setup;
  if (setup.length === 0) {
    return "skipped";
  }
  const runCommand = options.runCommand ?? runDevspaceCommand;
  for (const command of setup) {
    await runCommand(command.command, command.args, {
      cwd: options.worktreePath,
      env: compactEnv(options.env),
      stdin: "ignore",
    });
  }
  return "ran";
}

const runDevspaceCommand: RunnerDevspaceCommand = (command, args, options) =>
  execa(command, args, options);

function compactEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      Boolean(entry[1])
    )
  );
}
