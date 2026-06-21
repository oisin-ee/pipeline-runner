import { Effect } from "effect";
import { execa } from "execa";
import type { GhRunner, GhTextOptions } from "./gh-checks";

// ===========================================================================
// PIPE-88.8 — production GhRunner
//
// The single real adapter for the injected `gh` seam used by resolvePr,
// classifyChecks, and the merge executor. Two channels:
//   - json(args): a read gh invocation with a --json projection; stdout parsed.
//   - text(args, options?): a mutating gh invocation whose stdout is returned.
//
// SECURITY CONTRACT (88.5): `text` injects `options.secretEnv` (e.g. the admin
// bypass token under GH_TOKEN) into the CHILD PROCESS ENVIRONMENT only — never
// into argv. execa is given `{ env: { ...secretEnv } }`; the secret therefore
// never appears in the command line, a process listing, or an args log. `args`
// is always free of secrets by construction: the caller hands the token through
// `secretEnv`, not through `args`.
// ===========================================================================

/** The slice of the subprocess runner the GhRunner depends on (injected in tests). */
export type GhExec = (
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>> }
) => Promise<{ readonly stdout: string }>;

/** Default exec: invoke the real `gh` binary via execa, extending the parent env. */
const defaultGhExec: GhExec = (args, options) =>
  execa("gh", [...args], {
    // extendEnv defaults to true, so secretEnv values are MERGED onto the
    // inherited environment for this child only — never persisted, never in argv.
    ...(options.env ? { env: options.env } : {}),
  });

export interface GhRunnerOptions {
  /** Subprocess seam; defaults to the real `gh` execa runner. */
  readonly exec?: GhExec;
}

/**
 * Build a production `GhRunner`. `json` parses the `--json` stdout; `text`
 * returns raw stdout and routes any `secretEnv` into the child ENV.
 */
export function createGhRunner(options: GhRunnerOptions = {}): GhRunner {
  const exec = options.exec ?? defaultGhExec;
  return {
    json: (args) =>
      runGh(exec, args).pipe(Effect.flatMap((stdout) => parseGhJson(stdout))),
    text: (args, textOptions) => runGh(exec, args, textOptions),
  };
}

function runGh(
  exec: GhExec,
  args: readonly string[],
  options?: GhTextOptions
): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    catch: (error) => ghError(args, error),
    try: () => exec(args, envOption(options)),
  }).pipe(Effect.map((result) => result.stdout));
}

/** Translate GhTextOptions.secretEnv into the execa env channel (never argv). */
function envOption(options: GhTextOptions | undefined): {
  env?: Readonly<Record<string, string>>;
} {
  if (!options?.secretEnv) {
    return {};
  }
  return { env: options.secretEnv };
}

function parseGhJson(stdout: string): Effect.Effect<unknown, Error> {
  return Effect.try({
    catch: (error) =>
      new Error(
        `gh JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
      ),
    try: (): unknown => JSON.parse(stdout),
  });
}

function ghError(args: readonly string[], error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`gh ${args.join(" ")} failed: ${detail}`);
}
