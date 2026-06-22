import { Effect } from "effect";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three classes the loop acts on. */
export type CheckClassification = "fixable" | "indeterminate" | "infra-down";

/** Resolved PR identity — discriminated union avoids nullable fields. */
export type PrResolution =
  | { found: false }
  | { found: true; headRefName: string; number: number; url: string };

// ---------------------------------------------------------------------------
// DI boundary — injected gh runner (tests stub this, prod uses execa/gh)
// ---------------------------------------------------------------------------

/**
 * Options for a mutating `gh` invocation. `secretEnv` carries sensitive values
 * (e.g. `GH_TOKEN`) to the child process ENVIRONMENT only — never into argv, so
 * the raw secret never appears in a command line, process listing, or an args
 * log. This is the sole sanctioned transport for the admin bypass token.
 */
export interface GhTextOptions {
  readonly secretEnv?: Readonly<Record<string, string>>;
}

export interface GhRunner {
  /** Run a `gh …` command and parse the JSON response. */
  json: (args: string[]) => Effect.Effect<unknown, Error>;
  /**
   * Run a `gh …` command that does not emit JSON (e.g. `pr merge`) and return
   * its combined stdout text. Mutating commands route through here. Secret
   * values (the admin token) travel via `options.secretEnv`, never `args`.
   */
  text: (
    args: string[],
    options?: GhTextOptions
  ) => Effect.Effect<string, Error>;
}

// ---------------------------------------------------------------------------
// Zod schemas — boundary validation; no untyped casts
// ---------------------------------------------------------------------------

const prListItemSchema = z.object({
  headRefName: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
});

const prListSchema = z.array(prListItemSchema);

const checkRunSchema = z.object({
  conclusion: z.string().nullable(),
  name: z.string(),
  required: z.boolean(),
  status: z.string(),
});

const commitStatusSchema = z.object({
  required: z.boolean(),
  state: z.string(),
});

const checksResponseSchema = z.object({
  checkRuns: z.array(checkRunSchema),
  statuses: z.array(commitStatusSchema).default([]),
});

// ---------------------------------------------------------------------------
// Conclusion → classification lookup table
// ---------------------------------------------------------------------------

/**
 * Map of conclusive check-run conclusions to their classification.
 * Only the "positive infra signal" conclusions produce "infra-down".
 * "failure" produces "fixable". Everything else is absent from the table
 * (unknown/passing/neutral) and falls through to "indeterminate".
 */
const CONCLUSION_CLASS_TABLE: Readonly<Record<string, CheckClassification>> = {
  action_required: "fixable",
  cancelled: "infra-down",
  failure: "fixable",
  timed_out: "infra-down",
};

/** Commit-status states that are a positive infra signal. */
const COMMIT_STATUS_CLASS_TABLE: Readonly<Record<string, CheckClassification>> =
  {
    error: "infra-down",
  };

/**
 * Priority order: fixable > infra-down > indeterminate.
 * Used to merge a flat list of signals into the final classification.
 */
const CLASS_PRIORITY: Readonly<Record<CheckClassification, number>> = {
  fixable: 2,
  "infra-down": 1,
  indeterminate: 0,
};

function higherPriority(
  a: CheckClassification,
  b: CheckClassification
): CheckClassification {
  return CLASS_PRIORITY[a] >= CLASS_PRIORITY[b] ? a : b;
}

/** Map one required check-run to its classification signal (or null if not applicable). */
function checkRunSignal(
  run: z.infer<typeof checkRunSchema>
): CheckClassification | null {
  if (!run.required || run.conclusion === null) {
    return null;
  }
  return CONCLUSION_CLASS_TABLE[run.conclusion] ?? null;
}

/** Map one required commit status to its classification signal (or null if not applicable). */
function commitStatusSignal(
  status: z.infer<typeof commitStatusSchema>
): CheckClassification | null {
  if (!status.required) {
    return null;
  }
  return COMMIT_STATUS_CLASS_TABLE[status.state] ?? null;
}

// ---------------------------------------------------------------------------
// resolvePrForRun
// ---------------------------------------------------------------------------

/**
 * Locate the open PR whose head branch is `moka/run/<runId>`.
 * Returns a typed not-found result (never throws on absence).
 */
export function resolvePrForRun(
  runId: string,
  gh: GhRunner
): Effect.Effect<PrResolution, Error> {
  const headBranch = `moka/run/${runId}`;
  const args = [
    "pr",
    "list",
    "--head",
    headBranch,
    "--json",
    "number,headRefName,url",
  ];

  return gh.json(args).pipe(
    Effect.flatMap((raw) => parsePrList(raw)),
    Effect.map((items) => toPrResolution(items))
  );
}

function parsePrList(
  raw: unknown
): Effect.Effect<z.infer<typeof prListSchema>, Error> {
  const result = prListSchema.safeParse(raw);
  if (!result.success) {
    return Effect.fail(
      new Error(`gh pr list response parse failed: ${result.error.message}`)
    );
  }
  return Effect.succeed(result.data);
}

function toPrResolution(items: z.infer<typeof prListSchema>): PrResolution {
  const pr = items[0];
  if (pr === undefined) {
    return { found: false };
  }
  return {
    found: true,
    headRefName: pr.headRefName,
    number: pr.number,
    url: pr.url,
  };
}

// ---------------------------------------------------------------------------
// classifyRequiredChecks
// ---------------------------------------------------------------------------

/**
 * Classify required-check state for an open PR.
 *
 * Decision rules (checked in priority order):
 *   1. Any required check-run with a conclusion in CONCLUSION_CLASS_TABLE →
 *      return that class (fixable wins over infra-down when both present).
 *   2. Any required commit-status with state in INFRA_STATUS_STATES →
 *      infra-down.
 *   3. Otherwise → indeterminate (stuck in_progress / queued / no verdict).
 */
export function classifyRequiredChecks(
  pr: Extract<PrResolution, { found: true }>,
  gh: GhRunner
): Effect.Effect<CheckClassification, Error> {
  const args = [
    "pr",
    "checks",
    String(pr.number),
    "--json",
    "name,conclusion,status,required,startedAt",
  ];

  return gh.json(args).pipe(
    Effect.flatMap((raw) => parseChecksResponse(raw)),
    Effect.map((checks) => classifyChecks(checks))
  );
}

function parseChecksResponse(
  raw: unknown
): Effect.Effect<z.infer<typeof checksResponseSchema>, Error> {
  const result = checksResponseSchema.safeParse(raw);
  if (!result.success) {
    return Effect.fail(
      new Error(`gh pr checks response parse failed: ${result.error.message}`)
    );
  }
  return Effect.succeed(result.data);
}

function classifyChecks(
  checks: z.infer<typeof checksResponseSchema>
): CheckClassification {
  // Collect signals from both check-runs and commit statuses, filter nulls,
  // then reduce by priority (fixable > infra-down > indeterminate).
  const signals: CheckClassification[] = [
    ...checks.checkRuns.map(checkRunSignal),
    ...checks.statuses.map(commitStatusSignal),
  ].filter((s): s is CheckClassification => s !== null);

  return signals.reduce<CheckClassification>(higherPriority, "indeterminate");
}
