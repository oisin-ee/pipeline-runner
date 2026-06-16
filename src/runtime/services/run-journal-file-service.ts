import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";

export class RunJournalFileService extends Context.Tag("RunJournalFileService")<
  RunJournalFileService,
  {
    readonly appendLine: (
      path: string,
      line: string
    ) => Effect.Effect<void, unknown>;
    readonly readTextIfExists: (
      path: string
    ) => Effect.Effect<string | undefined, unknown>;
  }
>() {}

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
      try: () => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    }),
});
