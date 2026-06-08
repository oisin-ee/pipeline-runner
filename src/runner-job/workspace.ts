import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";
import { simpleGit } from "simple-git";
import type { RunnerJobPayload } from "../runner-job-contract";

export const RUNNER_JOB_WORKSPACE_PATH = "/workspace";

export interface RunnerWorkspacePreparation {
  dependencyBootstrap: RunnerWorkspaceDependencyBootstrap;
  env: Record<string, string | undefined>;
  worktreePath: string;
}

export type RunnerWorkspaceDependencyBootstrap =
  | {
      command: string;
      output: string;
      status: "installed";
    }
  | {
      reason: string;
      status: "skipped";
    };

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
  installDependencies?: RunnerDependencyInstaller;
  payload: RunnerWorkspacePayload;
}

export type RunnerDependencyInstaller = (
  worktreePath: string,
  env: Record<string, string | undefined>
) => Promise<RunnerWorkspaceDependencyBootstrap>;

export async function prepareRunnerWorkspace(
  options: PrepareRunnerWorkspaceOptions
): Promise<RunnerWorkspacePreparation> {
  const existingWorktreePath = options.env.PIPELINE_TARGET_PATH ?? options.cwd;
  if (existingWorktreePath) {
    return {
      dependencyBootstrap: {
        reason: "existing PIPELINE_TARGET_PATH or cwd is already prepared",
        status: "skipped",
      },
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
    const dependencyBootstrap = await (
      options.installDependencies ?? installRunnerWorkspaceDependencies
    )(RUNNER_JOB_WORKSPACE_PATH, options.env);
    return {
      dependencyBootstrap,
      env: {
        ...options.env,
        PIPELINE_TARGET_PATH: RUNNER_JOB_WORKSPACE_PATH,
      },
      worktreePath: RUNNER_JOB_WORKSPACE_PATH,
    };
  } catch (err) {
    throw new RunnerWorkspaceError(redactSecretText(errorMessage(err)));
  }
}

export async function installRunnerWorkspaceDependencies(
  worktreePath: string,
  env: Record<string, string | undefined>
): Promise<RunnerWorkspaceDependencyBootstrap> {
  if (!existsSync(join(worktreePath, "package.json"))) {
    return {
      reason: "package.json not found",
      status: "skipped",
    };
  }

  const pm = await detect({ cwd: worktreePath, stopDir: worktreePath });
  const resolved = resolveCommand(pm?.agent ?? "npm", "frozen", []);
  if (!resolved) {
    throw new RunnerWorkspaceError(
      `Could not resolve dependency install command for package manager '${pm?.agent ?? "npm"}'`
    );
  }

  const result = await execa(resolved.command, resolved.args, {
    cwd: worktreePath,
    env,
  });
  return {
    command: displayCommand(resolved.command, resolved.args),
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    status: "installed",
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

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
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
