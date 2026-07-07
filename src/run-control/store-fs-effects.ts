import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";

import { Effect, Option } from "effect";

import { isNotFound } from "./file-errors";

const MISSING_FILE_CONTENT = Option.none<string>();

export const readDirectoryEntriesEffect = (
  path: string
): Effect.Effect<Dirent[], unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await readdir(path, { withFileTypes: true }),
  });

export const ensureRunExistsEffect = (
  manifestPath: string,
  runId: string
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await stat(manifestPath),
  }).pipe(
    Effect.asVoid,
    Effect.catchIf(isNotFound, () =>
      Effect.fail(new Error(`Run ${runId} does not exist.`))
    )
  );

export const readFileUtf8Effect = (
  path: string
): Effect.Effect<string, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await readFile(path, "utf-8"),
  });

export const readOptionalFileEffect = (
  path: string
): Effect.Effect<Option.Option<string>, unknown> =>
  readFileUtf8Effect(path).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeed(MISSING_FILE_CONTENT))
  );

export const writeFileUtf8Effect = (
  path: string,
  content: string
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await writeFile(path, content, "utf-8");
    },
  });

export const writeJsonEffect = (
  path: string,
  value: unknown
): Effect.Effect<void, unknown> =>
  writeFileUtf8Effect(path, `${JSON.stringify(value, null, 2)}\n`);

export const appendFileUtf8Effect = (
  path: string,
  content: string
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await appendFile(path, content, "utf-8");
    },
  });

export const mkdirEffect = (
  path: string,
  options: Parameters<typeof mkdir>[1]
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await mkdir(path, options),
  }).pipe(Effect.asVoid);
