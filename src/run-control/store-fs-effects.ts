import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { Effect } from "effect";
import { isNotFound } from "./file-errors";

export function readDirectoryEntriesEffect(
  path: string
): Effect.Effect<Dirent[], unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readdir(path, { withFileTypes: true }),
  });
}

export function readOptionalFileEffect(
  path: string
): Effect.Effect<string | undefined, unknown> {
  return readFileUtf8Effect(path).pipe(
    Effect.catch((error) =>
      isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error)
    )
  );
}

export function ensureRunExistsEffect(
  manifestPath: string,
  runId: string
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => stat(manifestPath),
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.fail(new Error(`Run ${runId} does not exist.`))
        : Effect.fail(error)
    )
  );
}

export function readFileUtf8Effect(
  path: string
): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => readFile(path, "utf8"),
  });
}

export function writeJsonEffect(
  path: string,
  value: unknown
): Effect.Effect<void, unknown> {
  return writeFileUtf8Effect(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeFileUtf8Effect(
  path: string,
  content: string
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => writeFile(path, content, "utf8"),
  });
}

export function appendFileUtf8Effect(
  path: string,
  content: string
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => appendFile(path, content, "utf8"),
  });
}

export function mkdirEffect(
  path: string,
  options: Parameters<typeof mkdir>[1]
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => mkdir(path, options),
  }).pipe(Effect.asVoid);
}
