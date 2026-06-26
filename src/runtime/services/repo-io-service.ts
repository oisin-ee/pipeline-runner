import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { Cause, Context, Effect, Layer, Option } from "effect";
import { Language, Parser } from "web-tree-sitter";

let parserInitPromise: Promise<void> | null = null;

function initializeParser(): Promise<void> {
  parserInitPromise ??= Parser.init();
  return parserInitPromise;
}

export class RepoIoService extends Context.Service<
  RepoIoService,
  {
    readonly createParser: () => Effect.Effect<Parser, unknown>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly isDirectory: (path: string) => Effect.Effect<boolean, unknown>;
    readonly loadLanguage: (path: string) => Effect.Effect<Language, unknown>;
    readonly readDir: (path: string) => Effect.Effect<Dirent[], unknown>;
    readonly readText: (path: string) => Effect.Effect<string, unknown>;
  }
>()("RepoIoService") {}

export const RepoIoServiceLive = Layer.succeed(RepoIoService, {
  createParser: () =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        await initializeParser();
        return new Parser();
      },
    }),
  exists: (path) => Effect.sync(() => existsSync(path)),
  isDirectory: (path) =>
    Effect.try({
      catch: (error) => error,
      try: () => statSync(path).isDirectory(),
    }),
  loadLanguage: (path) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => Language.load(path),
    }),
  readDir: (path) =>
    Effect.try({
      catch: (error) => error,
      try: () => readdirSync(path, { withFileTypes: true }).sort(direntCompare),
    }),
  readText: (path) =>
    Effect.try({
      catch: (error) => error,
      try: () => readFileSync(path, "utf8"),
    }),
});

function direntCompare(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name);
}

export function runRepoIoSync<A, E>(
  program: Effect.Effect<A, E, RepoIoService>
): A {
  const exit = Effect.runSyncExit(Effect.provide(program, RepoIoServiceLive));
  if (exit._tag === "Success") {
    return exit.value;
  }
  const originalError = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (originalError) {
    throw originalError;
  }
  throw Cause.squash(exit.cause);
}
