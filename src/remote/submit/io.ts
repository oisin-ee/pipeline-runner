import { readFileSync } from "node:fs";

import { Option } from "effect";
import parseGitUrl from "git-url-parse";
import { simpleGit } from "simple-git";

import { normalizeRunnerRepositoryForSubmit } from "../../git-remote-url";
import type { ParsedMokaBaseOptions } from "../../moka-submit";
import type { RunnerRepositoryContext, RunnerRunIdentity } from "../../runner-command-contract";

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

export const readScheduleFile = (dependencies: Pick<MokaSubmitIoDependencies, "readFile">, path: string): string => {
  const readFile = dependencies.readFile ?? ((filePath: string) => readFileSync(filePath, "utf-8"));
  return readFile(path);
};

const repositoryContext = (options: ParsedMokaBaseOptions, git: MokaGitContext): RunnerRepositoryContext =>
  normalizeRunnerRepositoryForSubmit(
    options.repository ?? {
      baseBranch: git.baseBranch,
      sha: git.sha,
      url: git.url,
    },
  );

const assertRepositoryCredentialConfiguration = (options: ParsedMokaBaseOptions): void => {
  if (options.gitCredentialsSecretName === undefined || options.gitCredentialsSecretName.length === 0) {
    throw new Error("gitCredentialsSecretName is required for runner git clone, fetch, and push operations");
  }
};

const explicitSubmissionContext = (options: ParsedMokaBaseOptions): Option.Option<MokaSubmissionContext> => {
  if (options.repository === undefined || options.run === undefined) {
    return Option.none();
  }
  assertRepositoryCredentialConfiguration(options);
  return Option.some({
    repository: normalizeRunnerRepositoryForSubmit(options.repository),
    run: options.run,
  });
};

const runContext = (options: ParsedMokaBaseOptions, git: MokaGitContext, runId: string): RunnerRunIdentity =>
  options.run ?? {
    id: runId,
    project: git.project,
  };

const resolveGit = async (
  worktreePath: string,
  dependencies: Pick<MokaSubmitIoDependencies, "resolveGitContext">,
): Promise<MokaGitContext> => {
  if (dependencies.resolveGitContext !== undefined) {
    return await dependencies.resolveGitContext(worktreePath);
  }
  const git = simpleGit({ baseDir: worktreePath });
  const [branchResult, sha, remoteConfig] = await Promise.all([
    git.branch(),
    git.revparse(["HEAD"]),
    git.getConfig("remote.origin.url"),
  ]);
  const url = remoteConfig.value;
  if (url === null || url.length === 0) {
    throw new Error("Could not resolve git remote origin URL. Ensure the repository has a remote configured.");
  }
  return {
    baseBranch: branchResult.current,
    project: parseGitUrl(url).name.length > 0 ? parseGitUrl(url).name : "unknown",
    sha: sha.trim(),
    url,
  };
};

const resolveRequiredGit = async (
  options: { worktreePath?: string },
  dependencies: Pick<MokaSubmitIoDependencies, "resolveGitContext">,
): Promise<MokaGitContext> => {
  if (options.worktreePath === undefined || options.worktreePath.length === 0) {
    throw new Error("worktreePath is required when moka submit must resolve repository or run context");
  }
  return await resolveGit(options.worktreePath, dependencies);
};

export const resolveSubmissionContext = async (
  options: ParsedMokaBaseOptions & { worktreePath?: string },
  dependencies: Pick<MokaSubmitIoDependencies, "resolveGitContext">,
  runId: string,
): Promise<MokaSubmissionContext> => {
  const explicitContext = explicitSubmissionContext(options);
  if (Option.isSome(explicitContext)) {
    return explicitContext.value;
  }
  const git = await resolveRequiredGit(options, dependencies);
  const repository = repositoryContext(options, git);
  assertRepositoryCredentialConfiguration(options);
  return {
    repository,
    run: runContext(options, git, runId),
  };
};
