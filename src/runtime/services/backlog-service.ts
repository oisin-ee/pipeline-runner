import { Context, Data, Effect, Layer } from "effect";
import { execa } from "execa";

import { isRecord } from "../../safe-json";

export class BacklogCommandError extends Data.TaggedError("BacklogCommandError")<{
  readonly message: string;
  readonly stdout: string;
}> {}

const commandErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const commandErrorStdout = (error: unknown): string =>
  isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";

const toBacklogCommandError = (error: unknown): BacklogCommandError =>
  new BacklogCommandError({
    message: commandErrorMessage(error),
    stdout: commandErrorStdout(error),
  });

export class BacklogService extends Context.Service<
  BacklogService,
  {
    readonly run: (args: readonly string[], cwd: string) => Effect.Effect<string, BacklogCommandError>;
  }
>()("BacklogService") {}

export const BacklogServiceLive = Layer.succeed(BacklogService, {
  run: (args, cwd) =>
    Effect.tryPromise({
      catch: toBacklogCommandError,
      try: async () => await execa("backlog", [...args], { cwd }),
    }).pipe(Effect.map((result) => result.stdout)),
});
