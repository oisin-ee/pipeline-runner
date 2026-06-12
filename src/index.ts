#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { runCli } from "./cli/program";
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

if (isCliEntrypoint(process.argv)) {
  runCli(process.argv).catch((err: unknown) => {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (hasExitCode(err)) {
      if (err.message) {
        console.error(err.message);
      }
      process.exit(err.exitCode);
    }
    if (err instanceof Error) {
      if (err instanceof PipelineConfigError) {
        console.error(formatConfigError(err));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
    console.error(String(err));
    process.exit(1);
  });
}

function hasExitCode(err: unknown): err is Error & { exitCode: number } {
  return (
    err instanceof Error &&
    "exitCode" in err &&
    typeof (err as { exitCode?: unknown }).exitCode === "number"
  );
}
