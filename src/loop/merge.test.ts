import { inspect } from "node:util";

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { CheckClassification, GhRunner, PrResolution } from "./gh-checks";
import { adminMerge, enableAutoMerge, mergeForClassification, secretToken, selectMergeAction } from "./merge";
import type { SecretFileReader } from "./merge";

// ---------------------------------------------------------------------------
// Test doubles — record gh calls; never touch real GitHub or real secrets.
// ---------------------------------------------------------------------------

interface RecordingGh extends GhRunner {
  readonly jsonCalls: string[][];
  readonly secretEnvCalls: Option.Option<Readonly<Record<string, string>>>[];
  readonly textCalls: string[][];
}

const recordingGh = (
  text: (args: string[]) => Effect.Effect<string, Error> = () => Effect.succeed(""),
): RecordingGh => {
  const jsonCalls: string[][] = [];
  const textCalls: string[][] = [];
  const secretEnvCalls: Option.Option<Readonly<Record<string, string>>>[] = [];
  return {
    json: (args) => {
      jsonCalls.push(args);
      return Effect.fail(new Error(`unexpected json call: ${args.join(" ")}`));
    },
    jsonCalls,
    secretEnvCalls,
    text: (args, options) => {
      textCalls.push(args);
      secretEnvCalls.push(Option.fromNullishOr(options?.secretEnv));
      return text(args);
    },
    textCalls,
  };
};

const PR: Extract<PrResolution, { found: true }> = {
  found: true,
  headRefName: "moka/run/run-1",
  number: 99,
  url: "https://github.com/o/r/pull/99",
};

const tokenReader = (rawToken: Option.Option<string>): SecretFileReader => ({
  readBypassToken: () => Option.map(rawToken, (value) => secretToken(value)),
});

/** Secret reader that records whether the token was read — proves gating. */
const recordingTokenReader = (): {
  reader: SecretFileReader;
  wasRead: () => boolean;
} => {
  let read = false;
  return {
    reader: {
      readBypassToken: () => {
        read = true;
        return Option.some(secretToken("super-secret"));
      },
    },
    wasRead: () => read,
  };
};

// ---------------------------------------------------------------------------
// AC1: enableAutoMerge invokes `gh pr merge --auto` and returns pending.
// ---------------------------------------------------------------------------

describe("enableAutoMerge", () => {
  it("invokes `gh pr merge <n> --auto --squash` and returns pending", async () => {
    const gh = recordingGh();

    const outcome = await Effect.runPromise(enableAutoMerge(PR, gh));

    expect(gh.textCalls).toEqual([["pr", "merge", "99", "--auto", "--squash"]]);
    expect(outcome).toEqual({ _tag: "pending", pr: 99 });
  });

  it("surfaces a non-mergeable PR as a typed blocked conflict (not pending)", async () => {
    const gh = recordingGh(() => Effect.fail(new Error("Pull request #99 is not mergeable: merge conflict")));

    const outcome = await Effect.runPromise(enableAutoMerge(PR, gh));

    expect(outcome._tag).toBe("blocked");
    if (outcome._tag === "blocked") {
      expect(outcome.reason).toBe("merge-conflict");
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: admin path gated on classification + token never appears in any log/arg.
// ---------------------------------------------------------------------------

describe("selectMergeAction (dispatch table is the single gating owner)", () => {
  it("maps only infra-down to admin-merge", () => {
    expect(selectMergeAction("infra-down")).toBe("admin-merge");
    expect(selectMergeAction("fixable")).toBe("none");
    expect(selectMergeAction("indeterminate")).toBe("none");
  });
});

describe("mergeForClassification gating", () => {
  // Both non-infra classifications must short-circuit before reading the token.
  const noMergeClasses: CheckClassification[] = ["fixable", "indeterminate"];
  it.each(noMergeClasses)("performs NO merge and never reads the token for %s", async (classification) => {
    const gh = recordingGh();
    const secrets = recordingTokenReader();

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification,
        gh,
        pr: PR,
        secrets: secrets.reader,
      }),
    );

    expect(Option.isNone(outcome)).toBe(true);
    expect(gh.textCalls).toEqual([]);
    expect(secrets.wasRead()).toBe(false);
  });

  it("admin-merges ONLY on infra-down and reports merged", async () => {
    const gh = recordingGh();
    const secrets = tokenReader(Option.some("super-secret"));

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification: "infra-down",
        gh,
        pr: PR,
        secrets,
      }),
    );

    expect(outcome).toEqual(Option.some({ _tag: "merged", pr: 99 }));
    expect(gh.textCalls).toHaveLength(1);
    expect(gh.textCalls[0]).toContain("--admin");
  });
});

describe("adminMerge token confidentiality (AC2 redaction)", () => {
  const SECRET = "ghp_TOPSECRET_bypass_value_12345";

  it("does not expose the raw token through String/JSON/inspect", () => {
    const token = secretToken(SECRET);
    expect(String(token)).not.toContain(SECRET);
    expect(JSON.stringify({ token })).not.toContain(SECRET);
    expect(JSON.stringify(token)).not.toContain(SECRET);
    expect(inspect(token)).not.toContain(SECRET);
    // reveal() is the only way out, used solely at the auth-injection point.
    expect(token.reveal()).toBe(SECRET);
  });

  it("never lets the raw token reach argv; it travels only via secretEnv", async () => {
    const logLines: string[] = [];
    // The gh runner logs every arg UNFILTERED — if the raw secret were in argv
    // it would show here. The token must reach the child only via secretEnv.
    const gh = recordingGh((args) => {
      logLines.push(`gh ${args.join(" ")}`);
      return Effect.succeed("merged");
    });
    const token = secretToken(SECRET);

    const outcome = await Effect.runPromise(adminMerge(PR, token, gh));

    expect(outcome._tag).toBe("merged");
    // argv carries no bare secret (asserted without filtering the secret out).
    for (const args of gh.textCalls) {
      expect(args.join(" ")).not.toContain(SECRET);
    }
    for (const line of logLines) {
      expect(line).not.toContain(SECRET);
    }
    // the token IS delivered — but only through the env channel.
    expect(gh.secretEnvCalls.at(-1)).toEqual(Option.some({ GH_TOKEN: SECRET }));
  });
});

// ---------------------------------------------------------------------------
// AC3: merge conflict and missing token each surface as typed blocked.
// ---------------------------------------------------------------------------

describe("blocked outcomes (AC3 abuse/error paths)", () => {
  it("surfaces a missing bypass token as blocked, never a silent skip", async () => {
    const gh = recordingGh();
    const secrets = tokenReader(Option.none());

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification: "infra-down",
        gh,
        pr: PR,
        secrets,
      }),
    );

    expect(Option.isSome(outcome)).toBe(true);
    if (Option.isSome(outcome) && outcome.value._tag === "blocked") {
      expect(outcome.value.reason).toBe("missing-token");
    }
    // No merge was attempted without a token.
    expect(gh.textCalls).toEqual([]);
  });

  it("surfaces an admin-merge conflict as a typed blocked result", async () => {
    const gh = recordingGh(() => Effect.fail(new Error("merge conflict between head and base")));
    const secrets = tokenReader(Option.some("super-secret"));

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification: "infra-down",
        gh,
        pr: PR,
        secrets,
      }),
    );

    expect(Option.isSome(outcome)).toBe(true);
    if (Option.isSome(outcome) && outcome.value._tag === "blocked") {
      expect(outcome.value.reason).toBe("merge-conflict");
      expect(outcome.value.detail).toContain("merge conflict");
    }
  });

  it("classifies a non-conflict gh failure as not-mergeable (still blocked, not thrown)", async () => {
    const gh = recordingGh(() => Effect.fail(new Error("GraphQL: protected branch update failed")));
    const secrets = tokenReader(Option.some("super-secret"));

    const result = await Effect.runPromise(
      Effect.result(
        mergeForClassification({
          classification: "infra-down",
          gh,
          pr: PR,
          secrets,
        }),
      ),
    );

    // Surfaced as a value, not a thrown failure.
    expect(result._tag).toBe("Success");
    if (result._tag === "Success" && Option.isSome(result.success) && result.success.value._tag === "blocked") {
      expect(result.success.value.reason).toBe("not-mergeable");
    }
  });
});
