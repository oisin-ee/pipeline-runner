import { describe, expect, it } from "vitest";
import { loadPipelineConfig } from "./config";
import { createOrchestratorLaunchPlan, createRunnerLaunchPlan } from "./runner";

const config = loadPipelineConfig(process.cwd());

const baseInput = {
  nodeId: "n1",
  prompt: "do the thing",
  worktreePath: "/tmp/wt",
};

function argPair(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("reasoning effort → opencode model variant", () => {
  it("applies the profile reasoning_effort as --variant for the orchestrator", () => {
    const plan = createOrchestratorLaunchPlan(config, baseInput);
    expect(plan.model).toBe("broker/gpt-5.5");
    expect(plan.variant).toBe("xhigh");
    expect(argPair(plan.args, "--model")).toBe("broker/gpt-5.5");
    expect(argPair(plan.args, "--variant")).toBe("xhigh");
  });

  it("passes a node-level reasoning_effort as --variant for a broker GPT-5 model", () => {
    const plan = createRunnerLaunchPlan(config, {
      ...baseInput,
      model: "broker/gpt-5.5",
      profileId: "moka-code-writer",
      reasoningEffort: "high",
    });
    expect(plan.variant).toBe("high");
    expect(argPair(plan.args, "--variant")).toBe("high");
  });

  it("passes a node-level reasoning_effort as --variant for a GPT-5 model", () => {
    const plan = createRunnerLaunchPlan(config, {
      ...baseInput,
      model: "openai/gpt-5.5",
      profileId: "moka-code-writer",
      reasoningEffort: "high",
    });
    expect(plan.variant).toBe("high");
    expect(argPair(plan.args, "--variant")).toBe("high");
  });

  it("omits the variant when the selected model is not a variant-capable model", () => {
    const plan = createRunnerLaunchPlan(config, {
      ...baseInput,
      model: "kimi-for-coding/k2p6",
      profileId: "moka-code-writer",
      reasoningEffort: "high",
    });
    expect(plan.variant).toBeUndefined();
    expect(plan.args).not.toContain("--variant");
  });
});
