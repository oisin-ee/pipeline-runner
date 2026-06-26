import { inspect } from "node:util";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CheckClassification, GhRunner, PrResolution } from "./gh-checks";
import {
  adminMerge,
  enableAutoMerge,
  mergeForClassification,
  type SecretFileReader,
  secretToken,
  selectMergeAction,
} from "./merge";

// ---------------------------------------------------------------------------
// Test doubles — record gh calls; never touch real GitHub or real secrets.
// ---------------------------------------------------------------------------

interface RecordingGh extends GhRunner {
  readonly jsonCalls: string[][];
  readonly secretEnvCalls: (Readonly<Record<string, string>> | undefined)[];
  readonly textCalls: string[][];
}

function recordingGh(
  text: (args: string[]) => Effect.Effect<string, Error> = () =>
    Effect.succeed("")
): RecordingGh {
  const jsonCalls: string[][] = [];
  const textCalls: string[][] = [];
  const secretEnvCalls: (Readonly<Record<string, string>> | undefined)[] = [];
  return {
    json: (args) => {
      jsonCalls.push(args);
      return Effect.fail(new Error(`unexpected json call: ${args.join(" ")}`));
    },
    jsonCalls,
    secretEnvCalls,
    text: (args, options) => {
      textCalls.push(args);
      secretEnvCalls.push(options?.secretEnv);
      return text(args);
    },
    textCalls,
  };
}

const PR: Extract<PrResolution, { found: true }> = {
  found: true,
  headRefName: "moka/run/run-1",
  number: 99,
  url: "https://github.com/o/r/pull/99",
};

function tokenReader(rawToken: string | null): SecretFileReader {
  return {
    readBypassToken: () => (rawToken === null ? null : secretToken(rawToken)),
  };
}

/** Secret reader that records whether the token was read — proves gating. */
function recordingTokenReader(): {
  reader: SecretFileReader;
  wasRead: () => boolean;
} {
  let read = false;
  return {
    reader: {
      readBypassToken: () => {
        read = true;
        return secretToken("super-secret");
      },
    },
    wasRead: () => read,
  };
}

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
    const gh = recordingGh(() =>
      Effect.fail(
        new Error("Pull request #99 is not mergeable: merge conflict")
      )
    );

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
  it.each(
    noMergeClasses
  )("performs NO merge and never reads the token for %s", async (classification) => {
    const gh = recordingGh();
    const secrets = recordingTokenReader();

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification,
        gh,
        pr: PR,
        secrets: secrets.reader,
      })
    );

    expect(outcome).toBeNull();
    expect(gh.textCalls).toEqual([]);
    expect(secrets.wasRead()).toBe(false);
  });

  it("admin-merges ONLY on infra-down and reports merged", async () => {
    const gh = recordingGh();
    const secrets = tokenReader("super-secret");

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification: "infra-down",
        gh,
        pr: PR,
        secrets,
      })
    );

    expect(outcome).toEqual({ _tag: "merged", pr: 99 });
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
    expect(gh.secretEnvCalls.at(-1)).toEqual({ GH_TOKEN: SECRET });
  });
});

// ---------------------------------------------------------------------------
// AC3: merge conflict and missing token each surface as typed blocked.
// ---------------------------------------------------------------------------

describe("blocked outcomes (AC3 abuse/error paths)", () => {
  it("surfaces a missing bypass token as blocked, never a silent skip", async () => {
    const gh = recordingGh();
    const secrets = tokenReader(null);

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification: "infra-down",
        gh,
        pr: PR,
        secrets,
      })
    );

    expect(outcome).not.toBeNull();
    expect(outcome?._tag).toBe("blocked");
    if (outcome?._tag === "blocked") {
      expect(outcome.reason).toBe("missing-token");
    }
    // No merge was attempted without a token.
    expect(gh.textCalls).toEqual([]);
  });

  it("surfaces an admin-merge conflict as a typed blocked result", async () => {
    const gh = recordingGh(() =>
      Effect.fail(new Error("merge conflict between head and base"))
    );
    const secrets = tokenReader("super-secret");

    const outcome = await Effect.runPromise(
      mergeForClassification({
        classification: "infra-down",
        gh,
        pr: PR,
        secrets,
      })
    );

    expect(outcome?._tag).toBe("blocked");
    if (outcome?._tag === "blocked") {
      expect(outcome.reason).toBe("merge-conflict");
      expect(outcome.detail).toContain("merge conflict");
    }
  });

  it("classifies a non-conflict gh failure as not-mergeable (still blocked, not thrown)", async () => {
    const gh = recordingGh(() =>
      Effect.fail(new Error("GraphQL: protected branch update failed"))
    );
    const secrets = tokenReader("super-secret");

    const result = await Effect.runPromise(
      Effect.result(
        mergeForClassification({
          classification: "infra-down",
          gh,
          pr: PR,
          secrets,
        })
      )
    );

    // Surfaced as a value, not a thrown failure.
    expect(result._tag).toBe("Success");
    if (result._tag === "Success" && result.success?._tag === "blocked") {
      expect(result.success.reason).toBe("not-mergeable");
    }
  });
});
