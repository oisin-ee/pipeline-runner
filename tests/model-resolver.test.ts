import { afterEach, describe, expect, it } from "vitest";
import { selectNodeModel } from "../src/model-resolver";
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

describe("selectNodeModel", () => {
  it("uses explicit node model order", () => {
    const selected = selectNodeModel(
      node(["openai/gpt-5.5", "kimi-for-coding/k2p6"])
    );

    expect(selected).toEqual({
      model: "openai/gpt-5.5",
      reason: "selected first enabled model from node fallback array",
      skipped: [],
    });
  });

  it("skips disabled models", () => {
    process.env.PIPELINE_DISABLED_MODELS = "openai/gpt-5.5";

    const selected = selectNodeModel(
      node(["openai/gpt-5.5", "kimi-for-coding/k2p6"])
    );

    expect(selected).toMatchObject({
      model: "kimi-for-coding/k2p6",
      skipped: ["openai/gpt-5.5"],
    });
  });

  it("falls back past an unavailable preferred model to an available one", () => {
    const selected = selectNodeModel(
      node(["opencode-go/qwen3.7-max", "openai/gpt-5.5-high"]),
      { available: new Set(["openai/gpt-5.5-high"]) }
    );

    expect(selected).toMatchObject({
      model: "openai/gpt-5.5-high",
      skipped: ["opencode-go/qwen3.7-max"],
    });
  });

  it("selects the preferred model when it is available", () => {
    const selected = selectNodeModel(
      node(["opencode-go/qwen3.7-max", "openai/gpt-5.5-high"]),
      {
        available: new Set(["opencode-go/qwen3.7-max", "openai/gpt-5.5-high"]),
      }
    );

    expect(selected.model).toBe("opencode-go/qwen3.7-max");
    expect(selected.skipped).toEqual([]);
  });

  it("returns no model when no candidate is available", () => {
    const selected = selectNodeModel(node(["opencode-go/qwen3.7-max"]), {
      available: new Set(["openai/gpt-5.5-high"]),
    });

    expect(selected.model).toBeUndefined();
    expect(selected.skipped).toEqual(["opencode-go/qwen3.7-max"]);
  });

  it("does not filter by availability when no set is provided", () => {
    const selected = selectNodeModel(node(["opencode-go/qwen3.7-max"]));
    expect(selected.model).toBe("opencode-go/qwen3.7-max");
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

describe("selectNodeModel size-aware routing", () => {
  it("skips models whose window cannot hold the node within the cap", () => {
    const selected = selectNodeModel(node(["small", "big"]), {
      estimatedTokens: 80_000,
      budget: budget({ windows: { small: 100_000, big: 400_000 } }),
    });
    // required = 80000 / 0.5 = 160000; small(100k) skipped, big(400k) fits.
    expect(selected.model).toBe("big");
    expect(selected.skipped).toContain("small");
    expect(selected.reason).toContain("80000");
  });

  it("keeps the first model when it already fits", () => {
    const selected = selectNodeModel(node(["big", "bigger"]), {
      estimatedTokens: 10_000,
      budget: budget({ windows: { big: 200_000, bigger: 400_000 } }),
    });
    expect(selected.model).toBe("big");
    expect(selected.skipped).toEqual([]);
  });

  it("returns no model with an explanatory reason when none fit", () => {
    const selected = selectNodeModel(node(["small", "smaller"]), {
      estimatedTokens: 300_000,
      budget: budget({ windows: { small: 100_000, smaller: 50_000 } }),
    });
    expect(selected.model).toBeUndefined();
    expect(selected.reason).toMatch(EXCEEDS_BUDGET_RE);
    expect(selected.skipped).toEqual(["small", "smaller"]);
  });

  it("falls back to the default window for unlisted models", () => {
    const selected = selectNodeModel(node(["mystery"]), {
      estimatedTokens: 80_000,
      budget: budget({ defaultWindow: 200_000 }),
    });
    // required 160000 <= default 200000 -> fits.
    expect(selected.model).toBe("mystery");
  });

  it("is unchanged from legacy behaviour when no options are given", () => {
    const selected = selectNodeModel(node(["a", "b"]));
    expect(selected).toEqual({
      model: "a",
      reason: "selected first enabled model from node fallback array",
      skipped: [],
    });
  });
});
