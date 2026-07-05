import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Effect, Option } from "effect";

import type { CheckClassification, GhRunner, PrResolution } from "./gh-checks";

// ---------------------------------------------------------------------------
// Trust boundary
// ---------------------------------------------------------------------------
//
// The bypass/admin token can push to PROTECTED `main` — it is the sensitive
// asset of this module. The attacker-influenceable inputs are the CI
// `CheckClassification` (derived from external GitHub check state) and the PR
// identity. The token is therefore:
//   1. read ONCE from a mounted secret FILE path (never an arg or echoed env),
//   2. wrapped in `SecretToken` whose string/JSON/inspect forms redact, so it
//      never leaks through logging or interpolation, and
//   3. only ever reachable on the `infra-down` action — the dispatch table is
//      the single owner of which classification may admin-merge.
// ---------------------------------------------------------------------------

const DEFAULT_MERGE_SECRETS_DIR = "/etc/pipeline/merge-bypass";
const MERGE_BYPASS_TOKEN_FILENAME = "token";

// ---------------------------------------------------------------------------
// SecretToken — a typed secret read once at the boundary; never renders raw.
// ---------------------------------------------------------------------------

/**
 * Opaque holder for the admin/bypass token. The raw value lives only in closure
 * scope behind `reveal()` — it is NOT a field on the returned object, so
 * `String(token)`, `JSON.stringify(token)` and `util.inspect` cannot reach it
 * by construction (they see only the `reveal` function). This is stronger than
 * overriding coercion hooks: there is no enumerable/own property to leak.
 * `reveal()` is the sole exit, called only at the auth-injection point.
 */
export interface SecretToken {
  readonly reveal: () => string;
}

/** Wrap a raw secret string so it can never be rendered, only revealed. */
export const secretToken = (value: string): SecretToken => ({
  reveal: () => value,
});

// ---------------------------------------------------------------------------
// Secret-file reader seam — injected so tests never touch a real mount.
// ---------------------------------------------------------------------------

export interface SecretFileReader {
  /** Read the bypass token from its mounted file. */
  readBypassToken: () => Option.Option<SecretToken>;
}

const mergeSecretsDir = (): string =>
  process.env.PIPELINE_MERGE_BYPASS_DIR ?? DEFAULT_MERGE_SECRETS_DIR;

/**
 * Production reader: follows the git-refs secret-from-file pattern —
 * `readFileSync(path).trim()` from an env-overridable mount dir, absence is a
 * typed `null` (surfaced as a `blocked` outcome), never a throw. Not exported:
 * it is the internal default for `mergeForClassification`; callers override it
 * only in tests via the `secrets` parameter.
 */
const fileSecretReader: SecretFileReader = {
  readBypassToken: () => {
    const path = resolve(mergeSecretsDir(), MERGE_BYPASS_TOKEN_FILENAME);
    if (!existsSync(path)) {
      return Option.none();
    }
    const value = readFileSync(path, "utf-8").trim();
    return value.length === 0 ? Option.none() : Option.some(secretToken(value));
  },
};

// ---------------------------------------------------------------------------
// Outcome types — a discriminated union; no nullable/throw-and-swallow paths.
// ---------------------------------------------------------------------------

/** Auto-merge armed; GitHub will land the PR once required CI goes green. */
export interface MergePending {
  readonly _tag: "pending";
  readonly pr: number;
}

/** PR merged immediately (admin bypass on a positively-classified infra outage). */
export interface Merged {
  readonly _tag: "merged";
  readonly pr: number;
}

/** Reason a merge could not proceed — every case is explicit and surfaced. */
export type BlockedReason =
  | "merge-conflict"
  | "missing-token"
  | "not-mergeable";

/** Typed non-merge outcome: surfaced to the caller, never silently swallowed. */
export interface MergeBlocked {
  readonly _tag: "blocked";
  readonly detail: string;
  readonly pr: number;
  readonly reason: BlockedReason;
}

export type MergeOutcome = MergePending | Merged | MergeBlocked;

type OpenPr = Extract<PrResolution, { found: true }>;

// ---------------------------------------------------------------------------
// Conflict detection — gh surfaces a non-mergeable PR via stderr text.
// ---------------------------------------------------------------------------

const CONFLICT_MARKERS: readonly string[] = [
  "not mergeable",
  "merge conflict",
  "conflicts with the base branch",
];

const blockedReasonForGhError = (message: string): BlockedReason => {
  const lower = message.toLowerCase();
  return CONFLICT_MARKERS.some((marker) => lower.includes(marker))
    ? "merge-conflict"
    : "not-mergeable";
};

const toBlocked = (pr: OpenPr, error: unknown): MergeBlocked => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    _tag: "blocked",
    detail: message,
    pr: pr.number,
    reason: blockedReasonForGhError(message),
  };
};

// ---------------------------------------------------------------------------
// AC1: enableAutoMerge — honors branch protection; returns PENDING (not merged).
// ---------------------------------------------------------------------------

/**
 * Arm GitHub auto-merge: `gh pr merge <n> --auto --squash`. GitHub holds the
 * PR until required CI is green, so this returns a PENDING status — the merge
 * is not terminal here. A non-mergeable PR (conflict) surfaces as `blocked`.
 */
export const enableAutoMerge = (
  pr: OpenPr,
  gh: GhRunner
): Effect.Effect<MergePending | MergeBlocked, Error> => {
  const args = ["pr", "merge", String(pr.number), "--auto", "--squash"];
  return gh.text(args).pipe(
    Effect.map((): MergePending => ({ _tag: "pending", pr: pr.number })),
    Effect.catch((error) => Effect.succeed(toBlocked(pr, error)))
  );
};

// ---------------------------------------------------------------------------
// AC2/AC3: adminMerge — ONLY callable for infra-down (enforced by dispatch).
// ---------------------------------------------------------------------------

/**
 * Admin-merge through branch protection using the bypass token. The token is
 * injected into the gh process via `GH_TOKEN` (env, never an argv) and is wrapped
 * so it cannot be logged. A non-mergeable PR surfaces as `blocked`.
 *
 * This is private to the dispatch path on purpose: `mergeForClassification` is
 * the only caller, and it only routes `infra-down` here. Exported for testing
 * the gating + redaction contract in isolation.
 */
export const adminMerge = (
  pr: OpenPr,
  token: SecretToken,
  gh: GhRunner
): Effect.Effect<Merged | MergeBlocked, Error> => {
  const args = ["pr", "merge", String(pr.number), "--admin", "--squash"];
  // The token is revealed ONCE, here at the auth-injection boundary, and handed
  // to the gh runner via `secretEnv` (child-process env), NOT via argv. The raw
  // value never enters `args`, so it cannot surface in a command line, process
  // listing, or an args log.
  return gh.text(args, { secretEnv: { GH_TOKEN: token.reveal() } }).pipe(
    Effect.map((): Merged => ({ _tag: "merged", pr: pr.number })),
    Effect.catch((error) => Effect.succeed(toBlocked(pr, error)))
  );
};

// ---------------------------------------------------------------------------
// Action selection — ONE owner: a data table keyed on the classification.
// ---------------------------------------------------------------------------

/** What this module does for each CI classification. */
export type MergeActionKind = "auto-merge" | "admin-merge" | "none";

/**
 * Single dispatch table over the 88.4 classification. This is the sole place
 * that decides which classification may admin-merge: only `infra-down`. There
 * is no branch ladder — to change policy you change this one map.
 */
const ACTION_FOR_CLASSIFICATION: Readonly<
  Record<CheckClassification, MergeActionKind>
> = {
  fixable: "none",
  indeterminate: "none",
  "infra-down": "admin-merge",
};

/** Pure lookup of the action a classification maps to. */
export const selectMergeAction = (
  classification: CheckClassification
): MergeActionKind => ACTION_FOR_CLASSIFICATION[classification];

// ---------------------------------------------------------------------------
// mergeForClassification — the orchestrated entrypoint.
// ---------------------------------------------------------------------------

/**
 * Decide and perform the merge action for a PR given its CI classification.
 *   - `fixable` / `indeterminate` → no merge (caller remediates); the admin
 *      token is never read on these paths.
 *   - `infra-down` → admin-merge with the bypass token (read once from file).
 *     A missing token surfaces as a typed `blocked`, never a silent skip.
 */
export const mergeForClassification = (input: {
  classification: CheckClassification;
  gh: GhRunner;
  pr: OpenPr;
  /** Secret reader; defaults to the mounted-file reader, overridden in tests. */
  secrets?: SecretFileReader;
}): Effect.Effect<Option.Option<MergeOutcome>, Error> => {
  const action = selectMergeAction(input.classification);
  if (action === "none") {
    return Effect.succeed(Option.none());
  }
  if (action === "auto-merge") {
    return enableAutoMerge(input.pr, input.gh).pipe(Effect.map(Option.some));
  }
  // action === "admin-merge" → infra-down only. Read the token at this boundary.
  const secrets = input.secrets ?? fileSecretReader;
  const token = secrets.readBypassToken();
  return Option.match(token, {
    onNone: () =>
      Effect.succeed(
        Option.some<MergeOutcome>({
          _tag: "blocked",
          detail: "admin-merge requires a bypass token but none was mounted",
          pr: input.pr.number,
          reason: "missing-token",
        })
      ),
    onSome: (value) =>
      adminMerge(input.pr, value, input.gh).pipe(Effect.map(Option.some)),
  });
};
