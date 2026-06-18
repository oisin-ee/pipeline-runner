import { Context, Effect, Layer } from "effect";
import simpleGit from "simple-git";

export interface OpenPullRequestGitClient {
  readonly raw: (args: string[]) => Effect.Effect<string, unknown>;
}

export class OpenPullRequestGitService extends Context.Tag(
  "OpenPullRequestGitService"
)<
  OpenPullRequestGitService,
  {
    readonly create: (
      baseDir: string
    ) => Effect.Effect<OpenPullRequestGitClient>;
  }
>() {}

export const OpenPullRequestGitServiceLive = Layer.succeed(
  OpenPullRequestGitService,
  {
    create: (baseDir) =>
      Effect.sync(() => {
        const git = simpleGit({ baseDir });
        return {
          raw: (args) => Effect.tryPromise(() => git.raw(args)),
        } satisfies OpenPullRequestGitClient;
      }),
  }
);
