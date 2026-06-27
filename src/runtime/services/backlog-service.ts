import { Context, Data, Effect, Layer } from "effect";
import { execa } from "execa";
import { isRecord } from "../../safe-json";

export class BacklogCommandError extends Data.TaggedError(
  "BacklogCommandError"
)<{
  readonly message: string;
  readonly stdout: string;
}> {}

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandErrorStdout(error: unknown): string {
  return isRecord(error) && typeof error.stdout === "string"
    ? error.stdout
    : "";
}

function toBacklogCommandError(error: unknown): BacklogCommandError {
  return new BacklogCommandError({
    message: commandErrorMessage(error),
    stdout: commandErrorStdout(error),
  });
}

export class BacklogService extends Context.Service<
  BacklogService,
  {
    readonly run: (
      args: readonly string[],
      cwd: string
    ) => Effect.Effect<string, BacklogCommandError>;
  }
>()("BacklogService") {}

export const BacklogServiceLive = Layer.succeed(BacklogService, {
  run: (args, cwd) =>
    Effect.tryPromise({
      catch: toBacklogCommandError,
      try: () => execa("backlog", [...args], { cwd }),
    }).pipe(Effect.map((result) => result.stdout)),
});
