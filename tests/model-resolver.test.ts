import { afterEach, describe, expect, it } from "vitest";
import { selectNodeModel } from "../src/model-resolver";
import type { PlannedWorkflowNode } from "../src/planning/compile";

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
});
