import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Cause, Context, Effect, Layer, Option } from "effect";

export class FileSystemService extends Context.Tag("FileSystemService")<
  FileSystemService,
  {
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly readText: (path: string) => Effect.Effect<string, unknown>;
    readonly writeText: (
      path: string,
      contents: string
    ) => Effect.Effect<void, unknown>;
  }
>() {}

export const FileSystemServiceLive = Layer.succeed(FileSystemService, {
  exists: (path) => Effect.sync(() => existsSync(path)),
  readText: (path) =>
    Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (error) => error,
    }),
  writeText: (path, contents) =>
    Effect.try({
      try: () => writeFileSync(path, contents),
      catch: (error) => error,
    }),
});

export function runFileSystemSync<A, E>(
  program: Effect.Effect<A, E, FileSystemService>,
  layer: typeof FileSystemServiceLive
): A {
  const exit = Effect.runSyncExit(Effect.provide(program, layer));
  switch (exit._tag) {
    case "Success":
      return exit.value;
    case "Failure": {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) {
        throw failure.value;
      }
      throw Cause.squash(exit.cause);
    }
    default:
      throw new Error("unreachable Effect exit state");
  }
}
