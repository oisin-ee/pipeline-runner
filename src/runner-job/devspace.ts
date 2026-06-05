import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import {
  loadPipelineConfig,
  type PipelineConfig,
  PipelineConfigError,
} from "../config.js";
import type { RunnerJobPayload } from "../runner-job-contract.js";

export interface RunnerDevspaceReadiness {
  config?: PipelineConfig;
  devspaceConfigPath?: string;
}

export type RunnerDevspaceCommand = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdin: "ignore" }
) => Promise<unknown>;

export function assertRunnerDevspaceReady(
  payload: Pick<RunnerJobPayload, "workspace">,
  worktreePath: string
): RunnerDevspaceReadiness {
  if (payload.workspace?.mode !== "clean-devspace") {
    return {};
  }

  const devspaceConfigPath = join(worktreePath, "devspace.yaml");
  if (!existsSync(devspaceConfigPath)) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_VALIDATION_ERROR",
      `Clean devspace runner jobs require ${devspaceConfigPath}`,
      [
        {
          message: "devspace.yaml is required for clean devspace runner jobs",
          path: "devspace.yaml",
        },
      ]
    );
  }

  return {
    config: loadPipelineConfig(worktreePath, {
      allowMissingLintFileReferences: true,
    }),
    devspaceConfigPath,
  };
}

export async function runRunnerDevspaceSmoke(options: {
  config: PipelineConfig;
  env: Record<string, string | undefined>;
  runCommand?: RunnerDevspaceCommand;
  worktreePath: string;
}): Promise<"ran" | "skipped"> {
  const smoke = options.config.runner_job.devspace_smoke;
  if (!smoke) {
    return "skipped";
  }
  const runCommand = options.runCommand ?? runDevspaceCommand;
  await runCommand(smoke.command, smoke.args, {
    cwd: options.worktreePath,
    env: compactEnv(options.env),
    stdin: "ignore",
  });
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
