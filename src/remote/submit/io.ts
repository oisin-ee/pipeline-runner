import { readFileSync } from "node:fs";
import parseGitUrl from "git-url-parse";
import { simpleGit } from "simple-git";
import { normalizeRunnerRepositoryForSubmit } from "../../git-remote-url";
import type { ParsedMokaBaseOptions } from "../../moka-submit";
import type {
  RunnerRepositoryContext,
  RunnerRunIdentity,
} from "../../runner-command-contract";

interface MokaGitContext {
  baseBranch: string;
  project: string;
  sha: string;
  url: string;
}

export interface MokaSubmissionContext {
  repository: RunnerRepositoryContext;
  run: RunnerRunIdentity;
}

export interface MokaSubmitIoDependencies {
  readFile?: (path: string) => string;
  resolveGitContext?: (worktreePath: string) => Promise<MokaGitContext>;
}

export function readScheduleFile(
  dependencies: Pick<MokaSubmitIoDependencies, "readFile">,
  path: string
): string {
  const readFile =
    dependencies.readFile ??
    ((filePath: string) => readFileSync(filePath, "utf8"));
  return readFile(path);
}

export async function resolveSubmissionContext(
  options: ParsedMokaBaseOptions & { worktreePath?: string },
  dependencies: Pick<MokaSubmitIoDependencies, "resolveGitContext">,
  runId: string
): Promise<MokaSubmissionContext> {
  const explicitContext = explicitSubmissionContext(options);
  if (explicitContext) {
    return explicitContext;
  }
  const git = await resolveRequiredGit(options, dependencies);
  const repository = repositoryContext(options, git);
  assertRepositoryCredentialConfiguration(options);
  return {
    repository,
    run: runContext(options, git, runId),
  };
}

function explicitSubmissionContext(
  options: ParsedMokaBaseOptions
): MokaSubmissionContext | null {
  if (!(options.repository && options.run)) {
    return null;
  }
  assertRepositoryCredentialConfiguration(options);
  return {
    repository: normalizeRunnerRepositoryForSubmit(options.repository),
    run: options.run,
  };
}

function resolveRequiredGit(
  options: { worktreePath?: string },
  dependencies: Pick<MokaSubmitIoDependencies, "resolveGitContext">
): Promise<MokaGitContext> {
  if (!options.worktreePath) {
    throw new Error(
      "worktreePath is required when moka submit must resolve repository or run context"
    );
  }
  return resolveGit(options.worktreePath, dependencies);
}

function repositoryContext(
  options: ParsedMokaBaseOptions,
  git: MokaGitContext
): RunnerRepositoryContext {
  return normalizeRunnerRepositoryForSubmit(
    options.repository ?? {
      baseBranch: git.baseBranch,
      sha: git.sha,
      url: git.url,
    }
  );
}

function assertRepositoryCredentialConfiguration(
  options: ParsedMokaBaseOptions
): void {
  if (!options.gitCredentialsSecretName) {
    throw new Error(
      "gitCredentialsSecretName is required for runner git clone, fetch, and push operations"
    );
  }
}

function runContext(
  options: ParsedMokaBaseOptions,
  git: MokaGitContext,
  runId: string
): RunnerRunIdentity {
  return (
    options.run ?? {
      id: runId,
      project: git.project,
    }
  );
}

async function resolveGit(
  worktreePath: string,
  dependencies: Pick<MokaSubmitIoDependencies, "resolveGitContext">
): Promise<MokaGitContext> {
  if (dependencies.resolveGitContext) {
    return dependencies.resolveGitContext(worktreePath);
  }
  const git = simpleGit({ baseDir: worktreePath });
  const [branchResult, sha, remoteConfig] = await Promise.all([
    git.branch(),
    git.revparse(["HEAD"]),
    git.getConfig("remote.origin.url"),
  ]);
  const url = remoteConfig.value;
  if (!url) {
    throw new Error(
      "Could not resolve git remote origin URL. Ensure the repository has a remote configured."
    );
  }
  return {
    baseBranch: branchResult.current,
    project: parseGitUrl(url).name || "unknown",
    sha: sha.trim(),
    url,
  };
}
