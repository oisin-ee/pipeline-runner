import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { Context, Effect, Layer } from "effect";

const execGit = promisify(execFile);

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
        const { stdout } = await execGit("git", args, {
          cwd,
          encoding: "utf-8",
          env,
        });
        return stdout;
      },
    }),
  statusPorcelain: (cwd) =>
    Effect.try({
      catch: (error) => error,
      try: () =>
        execFileSync(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
          {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }
        ),
    }),
});
