import { execa } from "execa";
import type { RunnerJobPayload } from "../runner-job-contract.js";

const GITHUB_HTTPS_REPOSITORY_RE =
  /^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/;
const GITHUB_SSH_REPOSITORY_RE = /^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/;

export interface PullRequestDeliveryResult {
  url: string;
}

export interface PullRequestDeliveryOptions {
  env: Record<string, string | undefined>;
  payload: Pick<RunnerJobPayload, "delivery" | "repository" | "task">;
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
  if (!options.payload.delivery.pullRequest) {
    return null;
  }
  const repository = options.payload.repository;
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
  const repositoryName = githubRepositoryName(repository.url);

  await runCommand("git", ["push", "--set-upstream", "origin", branch], {
    cwd: options.worktreePath,
    env,
    stdin: "ignore",
  });

  const result = await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--fill",
      "--base",
      repository.baseBranch,
      "--head",
      `${headOwner}:${branch}`,
      "--repo",
      repositoryName,
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

function githubRepositoryName(repositoryUrl: string): string {
  const httpsMatch = repositoryUrl.match(GITHUB_HTTPS_REPOSITORY_RE);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }
  const sshMatch = repositoryUrl.match(GITHUB_SSH_REPOSITORY_RE);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }
  throw new Error("Pull request delivery requires a GitHub repository URL");
}
