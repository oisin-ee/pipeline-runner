import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Context, Effect, Layer } from "effect";

const execGit = promisify(execFile);

export class GitPorcelainService extends Context.Tag("GitPorcelainService")<
  GitPorcelainService,
  {
    readonly run: (
      cwd: string,
      args: string[],
      env: NodeJS.ProcessEnv
    ) => Effect.Effect<string, unknown>;
    readonly statusPorcelain: (cwd: string) => Effect.Effect<string, unknown>;
  }
>() {}

export const GitPorcelainServiceLive = Layer.succeed(GitPorcelainService, {
  run: (cwd, args, env) =>
    Effect.tryPromise({
      try: async () => {
        const { stdout } = await execGit("git", args, {
          cwd,
          encoding: "utf8",
          env,
        });
        return stdout;
      },
      catch: (error) => error,
    }),
  statusPorcelain: (cwd) =>
    Effect.try({
      try: () =>
        execFileSync(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
          {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }
        ),
      catch: (error) => error,
    }),
});
