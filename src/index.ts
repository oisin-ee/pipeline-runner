#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { Cause, Effect, Exit } from "effect";
import { runCliEffect } from "./cli/program";
import { PipelineConfigError } from "./config";
import { formatConfigError } from "./pipeline-runtime";

// biome-ignore lint/performance/noBarrelFile: CLI package entrypoint intentionally re-exports the program API.
export {
  createCliProgram,
  execute,
  quick,
  runCli,
  runDoctor,
} from "./cli/program";

const PATH_SEPARATOR_RE = /[\\/]/;

function scriptName(argv: string[]): string {
  return argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
}

export function isCliEntrypoint(argv: string[]): boolean {
  const name = scriptName(argv);
  const entrypoint = normalizeEntrypointPath(argv[1]);
  const modulePath = normalizeEntrypointPath(fileURLToPath(import.meta.url));
  return entrypoint === modulePath || name === "moka";
}

function normalizeEntrypointPath(path: string | undefined): string | undefined {
  if (!path) {
    return;
  }
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

// Single Effect runMain boundary: the whole CLI runs as one Effect and its Exit
// is matched here — the only place the process maps a failure to an exit code.
if (isCliEntrypoint(process.argv)) {
  Effect.runPromiseExit(runCliEffect(process.argv)).then((exit) => {
    if (Exit.isFailure(exit)) {
      handleCliFailure(Cause.squash(exit.cause));
    }
  });
}

function handleCliFailure(err: unknown): never {
  const message = cliErrorMessage(err);
  if (message) {
    console.error(message);
  }
  process.exit(cliErrorCode(err));
}

function cliErrorCode(err: unknown): number {
  if (err instanceof CommanderError || hasExitCode(err)) {
    return err.exitCode;
  }
  return 1;
}

function cliErrorMessage(err: unknown): string | undefined {
  if (err instanceof CommanderError) {
    return;
  }
  if (err instanceof PipelineConfigError) {
    return formatConfigError(err);
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function hasExitCode(err: unknown): err is Error & { exitCode: number } {
  return (
    err instanceof Error &&
    "exitCode" in err &&
    typeof (err as { exitCode?: unknown }).exitCode === "number"
  );
}
