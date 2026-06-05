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

type RunnerWorkspacePayload = Pick<
  RunnerJobPayload,
  "repository" | "workspace"
> &
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
  if (options.payload.workspace?.mode !== "clean-devspace") {
    const worktreePath =
      options.env.PIPELINE_TARGET_PATH ?? options.cwd ?? process.cwd();
    return {
      env: { ...options.env },
      worktreePath,
    };
  }

  const repository = options.payload.repository;
  if (!repository) {
    throw new RunnerWorkspaceError(
      "repository is required for clean-devspace runner jobs"
    );
  }

  const git = options.createGitClient?.() ?? simpleGit();
  const cloneUrl = cloneUrlWithCredentials(options.payload, options.env);
  const branchName = runnerBranchName(options.payload);
  try {
    await git.clone(cloneUrl, RUNNER_JOB_WORKSPACE_PATH, ["--no-tags"]);
    await git
      .cwd(RUNNER_JOB_WORKSPACE_PATH)
      .checkoutBranch(branchName, repository.sha);
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

function cloneUrlWithCredentials(
  payload: Pick<RunnerJobPayload, "repository" | "workspace">,
  env: Record<string, string | undefined>
): string {
  const cloneUrl = payload.repository?.cloneUrl;
  if (!cloneUrl) {
    throw new RunnerWorkspaceError(
      "repository clone URL is required for clean-devspace runner jobs"
    );
  }
  const credentialEnv = payload.workspace?.cloneCredentialEnv;
  if (!credentialEnv) {
    return cloneUrl;
  }
  const credential = env[credentialEnv];
  if (!credential) {
    throw new RunnerWorkspaceError(
      `${credentialEnv} is required to clone the runner workspace`
    );
  }
  const url = parseCloneUrl(cloneUrl);
  if (!(url.protocol === "https:" || url.protocol === "http:")) {
    throw new RunnerWorkspaceError(
      "cloneCredentialEnv requires an HTTP(S) repository clone URL"
    );
  }
  url.username = url.username || "x-access-token";
  url.password = credential;
  return url.toString();
}

function parseCloneUrl(cloneUrl: string): URL {
  try {
    return new URL(cloneUrl);
  } catch {
    throw new RunnerWorkspaceError(
      "cloneCredentialEnv requires a valid repository clone URL"
    );
  }
}

function runnerBranchName(payload: RunnerWorkspacePayload): string {
  const runId = payload.run?.runId;
  const source = payload.task?.taskId || runId;
  if (!(source && runId)) {
    throw new RunnerWorkspaceError(
      "run and task context are required for clean-devspace runner jobs"
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
