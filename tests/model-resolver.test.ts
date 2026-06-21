import { afterEach, describe, expect, it } from "vitest";
import { selectNodeModelCandidates } from "../src/model-resolver";
import type { PlannedWorkflowNode } from "../src/planning/compile";

const EXCEEDS_BUDGET_RE = /exceeds 50% of every available/i;

const originalPipelineDisabledModels = process.env.PIPELINE_DISABLED_MODELS;

afterEach(() => {
  restoreEnv("PIPELINE_DISABLED_MODELS", originalPipelineDisabledModels);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function node(models: string[]): PlannedWorkflowNode {
  return {
    artifacts: [],
    dependents: [],
    gates: [],
    id: "agent",
    index: 0,
    kind: "agent",
    models,
    needs: [],
    profile: "moka-code-writer",
    retries: { max_attempts: 1 },
  };
}

describe("selectNodeModelCandidates", () => {
  it("returns the full ordered fallback set, preferred first", () => {
    const candidates = selectNodeModelCandidates(
      node(["openai/gpt-5.5", "kimi-for-coding/k2p6"])
    );

    expect(candidates).toEqual({
      models: ["openai/gpt-5.5", "kimi-for-coding/k2p6"],
      reason: "selected first enabled model from node fallback array",
      skipped: [],
    });
  });

  it("drops disabled models from the set", () => {
    process.env.PIPELINE_DISABLED_MODELS = "openai/gpt-5.5";

    const candidates = selectNodeModelCandidates(
      node(["openai/gpt-5.5", "kimi-for-coding/k2p6"])
    );

    expect(candidates).toMatchObject({
      models: ["kimi-for-coding/k2p6"],
      skipped: ["openai/gpt-5.5"],
    });
  });

  it("drops an unavailable preferred model but keeps the available fallback", () => {
    const candidates = selectNodeModelCandidates(
      node(["opencode-go/qwen3.7-max", "openai/gpt-5.5-high"]),
      { available: new Set(["openai/gpt-5.5-high"]) }
    );

    expect(candidates).toMatchObject({
      models: ["openai/gpt-5.5-high"],
      skipped: ["opencode-go/qwen3.7-max"],
    });
  });

  it("keeps every available model so a failed session can fall back", () => {
    const candidates = selectNodeModelCandidates(
      node(["opencode-go/qwen3.7-max", "openai/gpt-5.5-high"]),
      {
        available: new Set(["opencode-go/qwen3.7-max", "openai/gpt-5.5-high"]),
      }
    );

    expect(candidates.models).toEqual([
      "opencode-go/qwen3.7-max",
      "openai/gpt-5.5-high",
    ]);
    expect(candidates.skipped).toEqual([]);
  });

  it("returns an empty set when no candidate is available", () => {
    const candidates = selectNodeModelCandidates(
      node(["opencode-go/qwen3.7-max"]),
      {
        available: new Set(["openai/gpt-5.5-high"]),
      }
    );

    expect(candidates.models).toEqual([]);
    expect(candidates.skipped).toEqual(["opencode-go/qwen3.7-max"]);
  });

  it("does not filter by availability when no set is provided", () => {
    const candidates = selectNodeModelCandidates(
      node(["opencode-go/qwen3.7-max"])
    );
    expect(candidates.models).toEqual(["opencode-go/qwen3.7-max"]);
  });
});

function budget(overrides: {
  windows?: Record<string, number>;
  maxPct?: number;
  defaultWindow?: number;
}) {
  return {
    default_context_window: overrides.defaultWindow ?? 200_000,
    fan_out_width: { by_category: {}, default: 4 },
    max_context_pct: overrides.maxPct ?? 50,
    model_context_windows: overrides.windows ?? {},
  };
}

describe("selectNodeModelCandidates size-aware routing", () => {
  it("drops models whose window cannot hold the node within the cap", () => {
    const candidates = selectNodeModelCandidates(node(["small", "big"]), {
      estimatedTokens: 80_000,
      budget: budget({ windows: { small: 100_000, big: 400_000 } }),
    });
    // required = 80000 / 0.5 = 160000; small(100k) skipped, big(400k) fits.
    expect(candidates.models).toEqual(["big"]);
    expect(candidates.skipped).toContain("small");
    expect(candidates.reason).toContain("80000");
  });

  it("keeps every fitting model, preferred first", () => {
    const candidates = selectNodeModelCandidates(node(["big", "bigger"]), {
      estimatedTokens: 10_000,
      budget: budget({ windows: { big: 200_000, bigger: 400_000 } }),
    });
    expect(candidates.models).toEqual(["big", "bigger"]);
    expect(candidates.skipped).toEqual([]);
  });

  it("returns an empty set with an explanatory reason when none fit", () => {
    const candidates = selectNodeModelCandidates(node(["small", "smaller"]), {
      estimatedTokens: 300_000,
      budget: budget({ windows: { small: 100_000, smaller: 50_000 } }),
    });
    expect(candidates.models).toEqual([]);
    expect(candidates.reason).toMatch(EXCEEDS_BUDGET_RE);
    expect(candidates.skipped).toEqual(["small", "smaller"]);
  });

  it("falls back to the default window for unlisted models", () => {
    const candidates = selectNodeModelCandidates(node(["mystery"]), {
      estimatedTokens: 80_000,
      budget: budget({ defaultWindow: 200_000 }),
    });
    // required 160000 <= default 200000 -> fits.
    expect(candidates.models).toEqual(["mystery"]);
  });

  it("returns the whole set unchanged when no options are given", () => {
    const candidates = selectNodeModelCandidates(node(["a", "b"]));
    expect(candidates).toEqual({
      models: ["a", "b"],
      reason: "selected first enabled model from node fallback array",
      skipped: [],
    });
  });
});
