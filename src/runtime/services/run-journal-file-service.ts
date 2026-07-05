import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { Context, Effect, Layer, Option } from "effect";

export class RunJournalFileService extends Context.Service<
  RunJournalFileService,
  {
    readonly appendLine: (
      path: string,
      line: string
    ) => Effect.Effect<void, unknown>;
    readonly readTextIfExists: (
      path: string
    ) => Effect.Effect<Option.Option<string>, unknown>;
  }
>()("RunJournalFileService") {}

export const RunJournalFileServiceLive = Layer.succeed(RunJournalFileService, {
  appendLine: (path, line) =>
    Effect.try({
      catch: (error) => error,
      try: () => {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, line);
      },
    }),
  readTextIfExists: (path) =>
    Effect.try({
      catch: (error) => error,
      try: () =>
        existsSync(path)
          ? Option.some(readFileSync(path, "utf-8"))
          : Option.none(),
    }),
});
