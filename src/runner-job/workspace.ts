import { simpleGit } from "simple-git";
import type { RunnerJobPayload } from "../runner-job-contract.js";

export const RUNNER_JOB_WORKSPACE_PATH = "/workspace";

export interface RunnerWorkspacePreparation {
  env: Record<string, string | undefined>;
  worktreePath: string;
}

export interface RunnerGitClient {
  clone(
    repository: string,
    localPath: string,
    options?: string[]
  ): Promise<unknown>;
  cwd(path: string): {
    checkoutBranch(branch: string, startPoint: string): Promise<unknown>;
  };
}

type RunnerWorkspacePayload = Partial<Pick<RunnerJobPayload, "repository">> &
  Partial<Pick<RunnerJobPayload, "run" | "task">>;

export interface PrepareRunnerWorkspaceOptions {
  createGitClient?: () => RunnerGitClient;
  cwd?: string;
  env: Record<string, string | undefined>;
  payload: RunnerWorkspacePayload;
}

export async function prepareRunnerWorkspace(
  options: PrepareRunnerWorkspaceOptions
): Promise<RunnerWorkspacePreparation> {
  const existingWorktreePath = options.env.PIPELINE_TARGET_PATH ?? options.cwd;
  if (existingWorktreePath) {
    return {
      env: { ...options.env, PIPELINE_TARGET_PATH: existingWorktreePath },
      worktreePath: existingWorktreePath,
    };
  }

  const repository = options.payload.repository;
  if (!repository) {
    throw new RunnerWorkspaceError("repository is required for runner jobs");
  }

  const git = options.createGitClient?.() ?? simpleGit();
  const repositoryUrl = repository.url;
  const branchName = runnerBranchName(options.payload);
  try {
    await git.clone(repositoryUrl, RUNNER_JOB_WORKSPACE_PATH, ["--no-tags"]);
    await git
      .cwd(RUNNER_JOB_WORKSPACE_PATH)
      .checkoutBranch(
        branchName,
        repository.sha ?? `origin/${repository.baseBranch}`
      );
  } catch (err) {
    throw new RunnerWorkspaceError(redactSecretText(errorMessage(err)));
  }

  return {
    env: {
      ...options.env,
      PIPELINE_TARGET_PATH: RUNNER_JOB_WORKSPACE_PATH,
    },
    worktreePath: RUNNER_JOB_WORKSPACE_PATH,
  };
}

export class RunnerWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerWorkspaceError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CREDENTIAL_IN_URL_RE = /(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/g;

function redactSecretText(value: string): string {
  return value.replace(CREDENTIAL_IN_URL_RE, "$1$2:<redacted>@");
}

function runnerBranchName(payload: RunnerWorkspacePayload): string {
  const runId = payload.run?.id;
  const source = payload.task?.kind === "ticket" ? payload.task.id : runId;
  if (!(source && runId)) {
    throw new RunnerWorkspaceError(
      "run and task context are required for runner jobs"
    );
  }
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^[./-]+|[./-]+$/g, "")
    .replace(/\.{2,}/g, ".");
  return `pipeline/${normalized || runId}`;
}
