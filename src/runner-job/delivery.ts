import { execa } from "execa";
import type { RunnerJobPayload } from "../runner-job-contract.js";

export interface PullRequestDeliveryResult {
  url: string;
}

export interface PullRequestDeliveryOptions {
  env: Record<string, string | undefined>;
  payload: Pick<RunnerJobPayload, "repository" | "task" | "workspace">;
  runCommand?: RunnerDeliveryCommand;
  worktreePath: string;
}

export type RunnerDeliveryCommand = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdin: "ignore";
  }
) => Promise<{ stdout: string }>;

export type PullRequestCreator = (
  options: PullRequestDeliveryOptions
) => Promise<PullRequestDeliveryResult | null>;

export const createPullRequest: PullRequestCreator = async (options) => {
  if (options.payload.workspace?.mode !== "clean-devspace") {
    return null;
  }
  const repository = options.payload.repository;
  if (!repository) {
    return null;
  }
  const env = compactEnv(options.env);
  const runCommand = options.runCommand ?? runDeliveryCommand;
  const branchResult = await runCommand("git", ["branch", "--show-current"], {
    cwd: options.worktreePath,
    env,
    stdin: "ignore",
  });
  const branch = branchResult.stdout.trim();
  if (!branch) {
    throw new Error("Pull request delivery requires a checked-out branch");
  }
  const headOwner = options.env.PIPELINE_PR_HEAD_OWNER?.trim() || "oisin-bot";

  const result = await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--fill",
      "--base",
      repository.branch,
      "--head",
      `${headOwner}:${branch}`,
      "--repo",
      repository.fullName,
    ],
    {
      cwd: options.worktreePath,
      env,
      stdin: "ignore",
    }
  );
  const url = result.stdout.trim();
  return url ? { url } : null;
};

const runDeliveryCommand: RunnerDeliveryCommand = (command, args, options) =>
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
