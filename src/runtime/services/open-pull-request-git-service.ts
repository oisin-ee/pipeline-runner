import { Context, Effect, Layer } from "effect";

import { runAuthenticatedGit } from "../../run-state/git-refs";

export interface OpenPullRequestGitClient {
  readonly raw: (args: string[]) => Effect.Effect<string, unknown>;
}

export class OpenPullRequestGitService extends Context.Service<
  OpenPullRequestGitService,
  {
    readonly create: (
      baseDir: string
    ) => Effect.Effect<OpenPullRequestGitClient>;
  }
>()("OpenPullRequestGitService") {}

/*
 * The open-pull-request builtin pushes a real PR head branch over the same
 * HTTPS remote as node delivery, so it MUST authenticate the same way. Earlier
 * this used naked simple-git with no credential helper and no terminal-prompt
 * guard, so `git push` blocked indefinitely on an interactive username prompt
 * inside the runner pod. Delegating to runAuthenticatedGit gives every git op
 * here the runner's credential store + GIT_TERMINAL_PROMPT=0, fixing the hang
 * while keeping this service as the test-injection seam.
 */
const authenticatedGitClient = (baseDir: string): OpenPullRequestGitClient => ({
  raw: (args) =>
    Effect.tryPromise(async () => await runAuthenticatedGit(baseDir, args)),
});

export const OpenPullRequestGitServiceLive = Layer.succeed(
  OpenPullRequestGitService,
  {
    create: (baseDir) => Effect.sync(() => authenticatedGitClient(baseDir)),
  }
);
