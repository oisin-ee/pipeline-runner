import { Context, Effect, Layer } from "effect";
import { simpleGit } from "simple-git";

export interface DrainMergeGitClient {
  readonly raw: (args: string[]) => Effect.Effect<string, unknown>;
}

export class DrainMergeGitService extends Context.Service<
  DrainMergeGitService,
  {
    readonly create: (baseDir: string) => Effect.Effect<DrainMergeGitClient>;
  }
>()("DrainMergeGitService") {}

export const DrainMergeGitServiceLive = Layer.succeed(DrainMergeGitService, {
  create: (baseDir) =>
    Effect.sync(() => {
      const git = simpleGit({ baseDir });
      return {
        raw: (args) => Effect.tryPromise(async () => await git.raw(args)),
      } satisfies DrainMergeGitClient;
    }),
});
