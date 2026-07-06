import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { Cause, Context, Effect, Layer, Option } from "effect";

export class FileSystemService extends Context.Service<
  FileSystemService,
  {
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly readText: (path: string) => Effect.Effect<string, unknown>;
    readonly writeText: (path: string, contents: string) => Effect.Effect<void, unknown>;
  }
>()("FileSystemService") {}

export const FileSystemServiceLive = Layer.succeed(FileSystemService, {
  exists: (path) => Effect.sync(() => existsSync(path)),
  readText: (path) =>
    Effect.try({
      catch: (error) => error,
      try: () => readFileSync(path, "utf-8"),
    }),
  writeText: (path, contents) =>
    Effect.try({
      catch: (error) => error,
      try: () => {
        writeFileSync(path, contents);
      },
    }),
});

export const runFileSystemSync = <A, E>(
  program: Effect.Effect<A, E, FileSystemService>,
  layer: typeof FileSystemServiceLive,
): A => {
  const exit = Effect.runSyncExit(Effect.provide(program, layer));
  switch (exit._tag) {
    case "Success": {
      return exit.value;
    }
    case "Failure": {
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isSome(failure)) {
        throw failure.value;
      }
      throw Cause.squash(exit.cause);
    }
    default: {
      throw new Error("unreachable Effect exit state");
    }
  }
};
