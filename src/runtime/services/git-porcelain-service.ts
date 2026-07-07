import { Context, Effect, Layer } from "effect";
import { execa, execaSync } from "execa";

export class GitPorcelainService extends Context.Service<
  GitPorcelainService,
  {
    readonly run: (
      cwd: string,
      args: string[],
      env: NodeJS.ProcessEnv
    ) => Effect.Effect<string, unknown>;
    readonly statusPorcelain: (cwd: string) => Effect.Effect<string, unknown>;
  }
>()("GitPorcelainService") {}

export const GitPorcelainServiceLive = Layer.succeed(GitPorcelainService, {
  run: (cwd, args, env) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const { stdout } = await execa("git", args, {
          cwd,
          env,
          stdin: "ignore",
        });
        return stdout;
      },
    }),
  statusPorcelain: (cwd) =>
    Effect.try({
      catch: (error) => error,
      try: () =>
        execaSync(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
          {
            cwd,
            stderr: "ignore",
            stdin: "ignore",
          }
        ).stdout,
    }),
});
