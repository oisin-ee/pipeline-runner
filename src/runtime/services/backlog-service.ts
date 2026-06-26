// fallow-ignore-file unused-file
import { Context, Data, Effect, Layer } from "effect";
import { execa } from "execa";

// fallow-ignore-next-line unused-export
export class BacklogCommandError extends Data.TaggedError(
  "BacklogCommandError"
)<{
  readonly message: string;
  readonly stdout: string;
}> {}

// fallow-ignore-next-line unused-export
export class BacklogParseError extends Data.TaggedError("BacklogParseError")<{
  readonly message: string;
}> {}

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandErrorStdout(error: unknown): string {
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : "";
}

function toBacklogCommandError(error: unknown): BacklogCommandError {
  return new BacklogCommandError({
    message: commandErrorMessage(error),
    stdout: commandErrorStdout(error),
  });
}

// fallow-ignore-next-line unused-export
export class BacklogService extends Context.Service<
  BacklogService,
  {
    readonly run: (
      args: readonly string[],
      cwd: string
    ) => Effect.Effect<string, BacklogCommandError>;
  }
>()("BacklogService") {}

// fallow-ignore-next-line unused-export
export const BacklogServiceLive = Layer.succeed(BacklogService, {
  run: (args, cwd) =>
    Effect.tryPromise({
      catch: toBacklogCommandError,
      try: () => execa("backlog", [...args], { cwd }),
    }).pipe(Effect.map((result) => result.stdout)),
});
