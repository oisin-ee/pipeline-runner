import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import simpleGit from "simple-git";
import {
  DEFAULT_RUNNER_JOB_GIT_COMMITTER,
  type PipelineConfig,
} from "../config";
import type { RunnerJobPayload } from "../runner-job-contract";
import type { RunnerPullRequestSummary } from "./pr-summary";

const GITHUB_HTTPS_REPOSITORY_RE =
  /^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/;
const GITHUB_SSH_REPOSITORY_RE = /^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/;

export interface PullRequestDeliveryResult {
  url: string;
}

export interface GitBranchDeliveryResult {
  branch: string;
  commitSha: string | null;
  pushed: true;
}

export interface PullRequestDeliveryOptions {
  branch?: string;
  committer?: GitCommitter;
  createGitClient?: (worktreePath: string) => RunnerDeliveryGitClient;
  env: Record<string, string | undefined>;
  payload: Pick<RunnerJobPayload, "delivery" | "repository" | "run" | "task">;
  pullRequestSummary?: RunnerPullRequestSummary;
  runCommand?: RunnerDeliveryCommand;
  worktreePath: string;
}

export type GitCommitter = PipelineConfig["runner_job"]["git"]["committer"];

export interface RunnerDeliveryGitClient {
  add(files: string[]): Promise<unknown>;
  addConfig(
    key: string,
    value: string,
    append?: boolean,
    scope?: "local"
  ): Promise<unknown>;
  branch(): Promise<{ current: string }>;
  branchLocal(): Promise<{ branches: Record<string, unknown> }>;
  commit(message: string): Promise<unknown>;
  push(remote: string, branch: string, options: string[]): Promise<unknown>;
  revparse(args: string[]): Promise<string>;
  status(): Promise<{ files: unknown[] }>;
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

export type GitBranchDeliverer = (
  options: PullRequestDeliveryOptions
) => Promise<GitBranchDeliveryResult>;

export const deliverGitBranch: GitBranchDeliverer = async (options) => {
  const git = createDeliveryGitClient(options);
  const branch = options.branch ?? (await currentBranch(git));
  const status = await git.status();
  let commitSha: string | null = null;

  if (status.files.length > 0) {
    await git.add(["--all"]);
    await configureCommitter(
      git,
      options.committer ?? DEFAULT_RUNNER_JOB_GIT_COMMITTER
    );
    await git.commit(deliveryCommitMessage(options.payload));
    const remainingStatus = await git.status();
    if (remainingStatus.files.length > 0) {
      throw new Error(
        "Runner job delivery requires all worktree changes to be committed"
      );
    }
    commitSha = (await git.revparse(["HEAD"])).trim();
  }

  for (const branchToPush of await deliveryBranches(
    git,
    branch,
    options.payload.run.id
  )) {
    await git.push("origin", branchToPush, [
      "--set-upstream",
      "--force-with-lease",
    ]);
  }

  return { branch, commitSha, pushed: true };
};

export const createPullRequest: PullRequestCreator = async (options) => {
  if (!options.payload.delivery.pullRequest) {
    return null;
  }
  if (!options.pullRequestSummary) {
    throw new Error("Runner PR creation requires an explicit title and body");
  }
  const repository = options.payload.repository;
  const env = compactEnv(options.env);
  const runCommand = options.runCommand ?? runDeliveryCommand;
  const branch =
    options.branch ?? (await currentBranch(createDeliveryGitClient(options)));
  const repositoryName = githubRepositoryName(repository.url);
  const headOwner =
    options.env.PIPELINE_PR_HEAD_OWNER?.trim() ||
    githubRepositoryOwner(repositoryName);

  const head = `${headOwner}:${branch}`;
  const commandOptions = {
    cwd: options.worktreePath,
    env,
    stdin: "ignore" as const,
  };
  const bodyDir = mkdtempSync(join(tmpdir(), "pipeline-pr-"));
  const bodyFile = join(bodyDir, "body.md");
  writeFileSync(bodyFile, options.pullRequestSummary.body);
  try {
    const result = await runCommand(
      "gh",
      [
        "pr",
        "create",
        "--title",
        options.pullRequestSummary.title,
        "--body-file",
        bodyFile,
        "--base",
        repository.baseBranch,
        "--head",
        head,
        "--repo",
        repositoryName,
      ],
      commandOptions
    ).catch(async (err: unknown) => {
      const existing = await findExistingPullRequest({
        commandOptions,
        head,
        repositoryName,
        runCommand,
      }).catch(() => null);
      if (existing) {
        return existing;
      }
      throw err;
    });
    const url = result.stdout.trim();
    return url ? { url } : null;
  } finally {
    rmSync(bodyDir, { force: true, recursive: true });
  }
};

const runDeliveryCommand: RunnerDeliveryCommand = (command, args, options) =>
  execa(command, args, options);

function createDeliveryGitClient(
  options: PullRequestDeliveryOptions
): RunnerDeliveryGitClient {
  return (
    options.createGitClient?.(options.worktreePath) ??
    simpleGit({ baseDir: options.worktreePath })
  );
}

async function currentBranch(git: RunnerDeliveryGitClient): Promise<string> {
  const branch = (await git.branch()).current.trim();
  if (!branch) {
    throw new Error("Runner job delivery requires a checked-out branch");
  }
  return branch;
}

async function deliveryBranches(
  git: RunnerDeliveryGitClient,
  current: string,
  runId: string
): Promise<string[]> {
  const branches = await git.branchLocal();
  return [
    ...new Set([
      current,
      ...Object.keys(branches.branches)
        .map((branch) => branch.trim())
        .filter((branch) => isRunScopedBranch(branch, runId)),
    ]),
  ];
}

function isRunScopedBranch(branch: string, runId: string): boolean {
  return (
    branch.startsWith(`${runId}/`) || branch === `runs/integration/${runId}`
  );
}

function deliveryCommitMessage(
  payload: Pick<RunnerJobPayload, "run" | "task">
): string {
  const taskId =
    payload.task.kind === "ticket" ? payload.task.id.trim() : undefined;
  return `pipeline: ${taskId || payload.run.id}`;
}

async function configureCommitter(
  git: RunnerDeliveryGitClient,
  committer: GitCommitter
): Promise<void> {
  await git.addConfig("user.name", committer.name, false, "local");
  await git.addConfig("user.email", committer.email, false, "local");
}

function compactEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      Boolean(entry[1])
    )
  );
}

async function findExistingPullRequest(input: {
  commandOptions: {
    cwd: string;
    env: Record<string, string>;
    stdin: "ignore";
  };
  head: string;
  repositoryName: string;
  runCommand: RunnerDeliveryCommand;
}): Promise<{ stdout: string } | null> {
  const result = await input.runCommand(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      input.head,
      "--repo",
      input.repositoryName,
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ],
    input.commandOptions
  );
  return result.stdout.trim() ? result : null;
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

function githubRepositoryOwner(repositoryName: string): string {
  const [owner] = repositoryName.split("/");
  if (!owner) {
    throw new Error("Pull request delivery requires a GitHub repository owner");
  }
  return owner;
}
