#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { CommanderError } from "commander";
import { Cause, Effect, Exit, Option } from "effect";

import { runCliEffect } from "./cli/program";

export { runDoctor } from "./cli/doctor";
export { createCliProgram, runCli } from "./cli/program";
export { execute, quick } from "./cli/run-service";

const PATH_SEPARATOR_RE = /[\\/]/u;

const scriptName = (argv: string[]): string => argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";

const normalizeEntrypointPath = (path: Option.Option<string>): Option.Option<string> => {
  if (Option.isNone(path) || path.value.length === 0) {
    return Option.none();
  }
  const resolved = resolve(path.value);
  return Option.some(existsSync(resolved) ? realpathSync(resolved) : resolved);
};

export const isCliEntrypoint = (argv: string[]): boolean => {
  const name = scriptName(argv);
  const entrypoint = normalizeEntrypointPath(Option.fromUndefinedOr(argv[1]));
  const modulePath = normalizeEntrypointPath(Option.some(import.meta.filename));
  return (
    (Option.isSome(entrypoint) && Option.isSome(modulePath) && entrypoint.value === modulePath.value) || name === "moka"
  );
};

const hasExitCode = (err: unknown): err is Error & { exitCode: number } =>
  err instanceof Error && "exitCode" in err && typeof err.exitCode === "number";

const cliErrorCode = (err: unknown): number => {
  if (err instanceof CommanderError || hasExitCode(err)) {
    return err.exitCode;
  }
  return 1;
};

const handleCliFailure = (err: unknown): never => {
  process.exit(cliErrorCode(err));
};

// Single Effect runMain boundary: the whole CLI runs as one Effect and its Exit
// is matched here — the only place the process maps a failure to an exit code.
if (isCliEntrypoint(process.argv)) {
  void Effect.runPromiseExit(runCliEffect(process.argv)).then((exit) => {
    if (Exit.isFailure(exit)) {
      handleCliFailure(Cause.squash(exit.cause));
    }
  });
}
