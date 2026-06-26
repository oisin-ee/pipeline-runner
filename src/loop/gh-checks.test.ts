import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CheckClassification,
  classifyRequiredChecks,
  type GhRunner,
  type PrResolution,
  resolvePrForRun,
} from "./gh-checks";

// ---------------------------------------------------------------------------
// GhRunner stubs
// ---------------------------------------------------------------------------

function stubGhRunner(responses: Record<string, unknown>): GhRunner {
  return {
    json: (args: string[]) => {
      const key = args.join(" ");
      if (key in responses) {
        return Effect.succeed(responses[key]);
      }
      return Effect.fail(new Error(`unexpected gh call: ${key}`));
    },
    text: (args: string[]) =>
      Effect.fail(new Error(`unexpected gh text call: ${args.join(" ")}`)),
  };
}

// ---------------------------------------------------------------------------
// AC1: resolvePrForRun
// ---------------------------------------------------------------------------

describe("resolvePrForRun", () => {
  const PR_LIST_ARGS =
    "pr list --head moka/run/run-abc --json number,headRefName,url";

  it("returns the PR ref when gh finds a matching PR", async () => {
    const gh = stubGhRunner({
      [PR_LIST_ARGS]: [
        {
          number: 42,
          headRefName: "moka/run/run-abc",
          url: "https://github.com/o/r/pull/42",
        },
      ],
    });

    const result = await Effect.runPromise(resolvePrForRun("run-abc", gh));

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.number).toBe(42);
      expect(result.headRefName).toBe("moka/run/run-abc");
      expect(result.url).toBe("https://github.com/o/r/pull/42");
    }
  });

  it("returns not-found when gh returns an empty list", async () => {
    const gh = stubGhRunner({ [PR_LIST_ARGS]: [] });

    const result = await Effect.runPromise(resolvePrForRun("run-abc", gh));

    expect(result.found).toBe(false);
    expect(result).not.toHaveProperty("number");
  });

  it("surfaces gh execution errors as an Effect-level error", async () => {
    const gh: GhRunner = {
      json: () => Effect.fail(new Error("gh: not authenticated")),
      text: () => Effect.fail(new Error("gh: not authenticated")),
    };

    const result = await Effect.runPromise(
      Effect.result(resolvePrForRun("run-abc", gh))
    );

    expect(result._tag).toBe("Failure");
  });
});

// ---------------------------------------------------------------------------
// AC2: classifyRequiredChecks — table-driven verdict coverage
// ---------------------------------------------------------------------------

const PR_REF: Extract<PrResolution, { found: true }> = {
  found: true,
  headRefName: "moka/run/run-xyz",
  number: 7,
  url: "https://github.com/o/r/pull/7",
};

interface ChecksPayload {
  checkRuns: {
    conclusion: string | null;
    name: string;
    required: boolean;
    status: string;
  }[];
  statuses: {
    required: boolean;
    state: string;
  }[];
}

function stubChecks(payload: ChecksPayload): GhRunner {
  return stubGhRunner({
    "pr checks 7 --json name,conclusion,status,required,startedAt": payload,
  });
}

function classify(gh: GhRunner): Promise<CheckClassification> {
  return Effect.runPromise(classifyRequiredChecks(PR_REF, gh));
}

describe("classifyRequiredChecks", () => {
  // failure conclusion → fixable
  it("classifies failure conclusion as fixable", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: "failure",
          name: "ci/lint",
          required: true,
          status: "completed",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("fixable");
  });

  // cancelled conclusion → infra-down
  it("classifies cancelled conclusion as infra-down", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: "cancelled",
          name: "ci/build",
          required: true,
          status: "completed",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("infra-down");
  });

  // timed_out conclusion → infra-down
  it("classifies timed_out conclusion as infra-down", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: "timed_out",
          name: "ci/test",
          required: true,
          status: "completed",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("infra-down");
  });

  // commit status error → infra-down
  it("classifies commit status state=error as infra-down", async () => {
    const gh = stubChecks({
      checkRuns: [],
      statuses: [{ required: true, state: "error" }],
    });
    expect(await classify(gh)).toBe("infra-down");
  });

  // no conclusion (stuck in_progress) → indeterminate
  it("classifies stuck in_progress (no conclusion) as indeterminate", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: null,
          name: "ci/lint",
          required: true,
          status: "in_progress",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("indeterminate");
  });

  // queued, no conclusion → indeterminate
  it("classifies queued check with no conclusion as indeterminate", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: null,
          name: "ci/build",
          required: true,
          status: "queued",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("indeterminate");
  });

  // required check never reported (no required checks at all) → indeterminate
  it("classifies absence of required checks as indeterminate", async () => {
    const gh = stubChecks({ checkRuns: [], statuses: [] });
    expect(await classify(gh)).toBe("indeterminate");
  });

  // success → all passed, no failure signal → indeterminate
  it("classifies success conclusion as indeterminate (no failure signal)", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: "success",
          name: "ci/lint",
          required: true,
          status: "completed",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("indeterminate");
  });

  // non-required failure does not make it fixable
  it("ignores non-required check failure", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: "failure",
          name: "ci/optional",
          required: false,
          status: "completed",
        },
        {
          conclusion: "success",
          name: "ci/required",
          required: true,
          status: "completed",
        },
      ],
      statuses: [],
    });
    expect(await classify(gh)).toBe("indeterminate");
  });

  // ---------------------------------------------------------------------------
  // AC3: stuck in_progress + no positive infra signal → indeterminate (NOT infra-down)
  // ---------------------------------------------------------------------------
  it("AC3: stuck in_progress with no infra signal is indeterminate, never infra-down", async () => {
    const gh = stubChecks({
      checkRuns: [
        {
          conclusion: null,
          name: "ci/unit",
          required: true,
          status: "in_progress",
        },
        {
          conclusion: null,
          name: "ci/e2e",
          required: true,
          status: "in_progress",
        },
      ],
      statuses: [{ required: false, state: "pending" }],
    });

    const result = await classify(gh);

    expect(result).toBe("indeterminate");
    expect(result).not.toBe("infra-down");
  });
});
