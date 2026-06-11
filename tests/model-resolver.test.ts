import { afterEach, describe, expect, it } from "vitest";
import { selectNodeModel } from "../src/model-resolver";
import type { PlannedWorkflowNode } from "../src/workflow-planner";

const originalPipelineOpencodeModel = process.env.PIPELINE_OPENCODE_MODEL;
const originalPipelineDisabledModels = process.env.PIPELINE_DISABLED_MODELS;

afterEach(() => {
  restoreEnv("PIPELINE_OPENCODE_MODEL", originalPipelineOpencodeModel);
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
  it("uses PIPELINE_OPENCODE_MODEL ahead of explicit node fallbacks", () => {
    process.env.PIPELINE_OPENCODE_MODEL = "zai-coding-plan/glm-5.1";
    process.env.PIPELINE_DISABLED_MODELS = "zai-coding-plan/glm-5.1";

    const selected = selectNodeModel(
      node(["openai/gpt-5.5", "kimi-for-coding/k2p6"])
    );

    expect(selected).toEqual({
      model: "zai-coding-plan/glm-5.1",
      reason: "forced by PIPELINE_OPENCODE_MODEL",
      skipped: ["openai/gpt-5.5", "kimi-for-coding/k2p6"],
    });
  });

  it("skips disabled models when no override is configured", () => {
    process.env.PIPELINE_DISABLED_MODELS = "openai/gpt-5.5";

    const selected = selectNodeModel(
      node(["openai/gpt-5.5", "zai-coding-plan/glm-5.1"])
    );

    expect(selected).toMatchObject({
      model: "zai-coding-plan/glm-5.1",
      skipped: ["openai/gpt-5.5"],
    });
  });
});
