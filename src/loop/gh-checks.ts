import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  mutableArray,
  parseResultWithSchema,
  positiveInteger,
  struct,
} from "../schema-boundary";

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

const prListItemSchema = struct({
  headRefName: Schema.String,
  number: positiveInteger,
  url: Schema.String,
});

const prListSchema = mutableArray(prListItemSchema);

const checkRunSchema = struct({
  conclusion: Schema.NullOr(Schema.String),
  name: Schema.String,
  required: Schema.Boolean,
  status: Schema.String,
});

const commitStatusSchema = struct({
  required: Schema.Boolean,
  state: Schema.String,
});

const checksResponseSchema = struct({
  checkRuns: mutableArray(checkRunSchema),
  statuses: Schema.optional(mutableArray(commitStatusSchema)),
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
  indeterminate: 0,
  "infra-down": 1,
};

const DEFAULT_CHECK_CLASSIFICATION: CheckClassification = "indeterminate";

const higherPriority = (
  a: CheckClassification,
  b: CheckClassification
): CheckClassification => (CLASS_PRIORITY[a] >= CLASS_PRIORITY[b] ? a : b);

/** Map one required check-run to its classification signal. */
const checkRunSignal = (
  run: typeof checkRunSchema.Type
): Option.Option<CheckClassification> => {
  if (!run.required || run.conclusion === null) {
    return Option.none();
  }
  return Option.fromNullishOr(CONCLUSION_CLASS_TABLE[run.conclusion]);
};

/** Map one required commit status to its classification signal. */
const commitStatusSignal = (
  status: typeof commitStatusSchema.Type
): Option.Option<CheckClassification> => {
  if (!status.required) {
    return Option.none();
  }
  return Option.fromNullishOr(COMMIT_STATUS_CLASS_TABLE[status.state]);
};

const parsePrList = (
  raw: unknown
): Effect.Effect<typeof prListSchema.Type, Error> => {
  const result = parseResultWithSchema(prListSchema, raw);
  if (!result.ok) {
    return Effect.fail(
      new Error(`gh pr list response parse failed: ${result.error.message}`)
    );
  }
  return Effect.succeed(result.value);
};

const toPrResolution = (items: typeof prListSchema.Type): PrResolution =>
  Option.match(Option.fromNullishOr(items.at(0)), {
    onNone: () => ({ found: false }),
    onSome: (pr) => ({
      found: true,
      headRefName: pr.headRefName,
      number: pr.number,
      url: pr.url,
    }),
  });

// ---------------------------------------------------------------------------
// resolvePrForRun
// ---------------------------------------------------------------------------

/**
 * Locate the open PR whose head branch is `moka/run/<runId>`.
 * Returns a typed not-found result (never throws on absence).
 */
export const resolvePrForRun = (
  runId: string,
  gh: GhRunner
): Effect.Effect<PrResolution, Error> => {
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
};

const parseChecksResponse = (
  raw: unknown
): Effect.Effect<typeof checksResponseSchema.Type, Error> => {
  const result = parseResultWithSchema(checksResponseSchema, raw);
  if (!result.ok) {
    return Effect.fail(
      new Error(`gh pr checks response parse failed: ${result.error.message}`)
    );
  }
  return Effect.succeed(result.value);
};

const classifyChecks = (
  checks: typeof checksResponseSchema.Type
): CheckClassification => {
  // Collect signals from both check-runs and commit statuses, filter nulls,
  // then reduce by priority (fixable > infra-down > indeterminate).
  const signals: CheckClassification[] = [
    ...checks.checkRuns.map(checkRunSignal),
    ...(checks.statuses ?? []).map(commitStatusSignal),
  ].flatMap((signal) =>
    Option.match(signal, {
      onNone: () => [],
      onSome: (value) => [value],
    })
  );

  return Arr.reduce(signals, DEFAULT_CHECK_CLASSIFICATION, higherPriority);
};

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
export const classifyRequiredChecks = (
  pr: Extract<PrResolution, { found: true }>,
  gh: GhRunner
): Effect.Effect<CheckClassification, Error> => {
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
};
