import parseGitUrl from "git-url-parse";

import type { RunnerRepositoryContext } from "./runner-command-contract";

const GITHUB_SOURCE = "github.com";

const requiredGitHubPathSegment = (
  value: string,
  remoteUrl: string
): string => {
  const segment = value.trim();
  if (segment.length > 0) {
    return segment;
  }
  throw new Error(
    `GitHub SSH git remote ${remoteUrl} must include an owner and repository name`
  );
};

const gitHubRepositoryPath = (
  parsed: ReturnType<typeof parseGitUrl>,
  remoteUrl: string
): string => {
  const owner = requiredGitHubPathSegment(parsed.owner, remoteUrl);
  const name = requiredGitHubPathSegment(parsed.name, remoteUrl);
  return `${owner}/${name}.git`;
};

const isSshRemote = (parsed: ReturnType<typeof parseGitUrl>): boolean =>
  parsed.protocols.includes("ssh");

const normalizeRepositoryUrlForSubmit = (remoteUrl: string): string => {
  const parsed = parseGitUrl(remoteUrl);
  if (!isSshRemote(parsed)) {
    return remoteUrl;
  }
  if (parsed.source !== GITHUB_SOURCE) {
    throw new Error(
      `SSH git remote ${remoteUrl} is not supported for moka submit; use an HTTPS GitHub remote`
    );
  }
  return `https://${GITHUB_SOURCE}/${gitHubRepositoryPath(parsed, remoteUrl)}`;
};

export const normalizeRunnerRepositoryForSubmit = (
  repository: RunnerRepositoryContext
): RunnerRepositoryContext => {
  const url = normalizeRepositoryUrlForSubmit(repository.url);
  if (url === repository.url) {
    return repository;
  }
  return { ...repository, url };
};
