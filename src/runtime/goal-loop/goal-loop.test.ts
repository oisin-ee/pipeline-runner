import { describe, expect, it } from "vitest";

import { loadPipelineConfig } from "../../config";
import { applyGoalStateEvent, createGoalState, recordGoalStateChangedFiles } from "../goal-state/goal-state";
import type { PipelineGoalState } from "../goal-state/goal-state";
import { renderContinuationPrompt } from "./continuation-prompt";
import { createGoalContinuationLaunchPlan, runBoundedGoalLoop } from "./goal-loop";

const verifierFailureState = (options: { priorAttempt?: boolean } = {}): PipelineGoalState => {
  const initial = createGoalState({
    runId: "run-1",
    scheduleId: "schedule-1",
    schedulePath: ".pipeline/runs/run-1/schedule.yaml",
    task: "Ship PIPE-52",
    taskContext: {
      acceptanceCriteria: [{ id: "AC1", text: "CLI evidence is present" }],
      description: "Build the continuation loop.",
      id: "PIPE-52",
      title: "OpenCode first goal loop",
    },
    workflowId: "root",
  });
  const planned = applyGoalStateEvent(initial, {
    edges: [],
    nodes: [
      {
        id: "verify",
        kind: "agent",
        needs: [],
        profile: "moka-verifier",
        runnerId: "opencode",
      },
    ],
    type: "workflow.planned",
    workflowId: "root",
  });
  const failed = applyGoalStateEvent(
    applyGoalStateEvent(planned, {
      attempt: 1,
      nodeId: "verify",
      profile: "moka-verifier",
      runnerId: "opencode",
      type: "node.start",
    }),
    {
      evidence: ["verifier found missing CLI evidence"],
      gateId: "verify-verdict",
      kind: "verdict",
      nodeId: "verify",
      passed: false,
      reason: "verdict requirement failed",
      type: "gate.finish",
    },
  );
  const finished = applyGoalStateEvent(failed, {
    attempt: 1,
    exitCode: 1,
    nodeId: "verify",
    profile: "moka-verifier",
    runnerId: "opencode",
    status: "failed",
    type: "node.finish",
  });
  const withFiles = recordGoalStateChangedFiles(finished, "green", ["src/feature.ts"]);
  if (options.priorAttempt === false) {
    return withFiles;
  }
  return {
    ...withFiles,
    continuationAttempts: [
      {
        attempt: 1,
        promptPath: ".pipeline/runs/run-1/continue-1.md",
        reason: "verifier requested fixes",
        verifierNodeId: "verify",
      },
    ],
  };
};

describe("pipeline goal loop", () => {
  it("renders a continuation prompt with task, node, failures, evidence, files, attempts, and next requirement", () => {
    const state = verifierFailureState();
    const prompt = renderContinuationPrompt({ state });

    expect(prompt).toContain("Ship PIPE-52");
    expect(prompt).toContain("- id: PIPE-52");
    expect(prompt).toContain("## Current Schedule Node Context");
    expect(prompt).toContain("- node_id: verify");
    expect(prompt).toContain("verify/verify-verdict");
    expect(prompt).toContain("verifier found missing CLI evidence");
    expect(prompt).toContain("- src/feature.ts");
    expect(prompt).toContain("#1: verifier requested fixes");
    expect(prompt).toContain("## Exact Next Requirement");
    expect(prompt).toContain("Satisfy verifier node 'verify'");
  });

  it("stops when the maximum continuation count is reached", async () => {
    const result = await runBoundedGoalLoop({
      initialState: verifierFailureState({ priorAttempt: false }),
      maxContinuations: 1,
      runContinuation: ({ state }) => recordGoalStateChangedFiles(state, "green", ["src/progress.ts"]),
    });

    expect(result.terminalState).toBe("max_continuations_reached");
    expect(result.attempts).toBe(1);
    expect(result.prompts).toHaveLength(1);
  });

  it("stops on no progress when the same failure repeats without new files or evidence", async () => {
    const result = await runBoundedGoalLoop({
      initialState: verifierFailureState(),
      maxContinuations: 3,
      runContinuation: ({ state }) => state,
    });

    expect(result.terminalState).toBe("no_progress_detected");
    expect(result.state.terminalOutcome).toBe("BLOCKED");
    expect(result.state.blockedReasons).toContain("same failure repeated without new changed files or evidence");
  });

  it("stops cleanly when cancellation is requested", async () => {
    const result = await runBoundedGoalLoop({
      initialState: verifierFailureState(),
      maxContinuations: 3,
      runContinuation: ({ state }) => state,
      shouldCancel: () => true,
    });

    expect(result.terminalState).toBe("cancelled");
    expect(result.attempts).toBe(1);
  });

  it("continues after a recoverable verifier failure and returns passed when the rerun passes", async () => {
    const result = await runBoundedGoalLoop({
      initialState: verifierFailureState(),
      maxContinuations: 2,
      runContinuation: ({ prompt, state }) => {
        expect(prompt).toContain("verifier found missing CLI evidence");
        const accepted = applyGoalStateEvent(state, {
          attempt: 1,
          format: "json_schema",
          nodeId: "acceptance",
          output: {
            acceptance: [{ evidence: ["AC1 covered"], id: "AC1", verdict: "PASS" }],
            evidence: ["acceptance passed"],
            verdict: "PASS",
          },
          profile: "moka-acceptance-reviewer",
          schemaPath: ".pipeline/schemas/acceptance.schema.json",
          type: "node.output.recorded",
        });
        const verified = applyGoalStateEvent(accepted, {
          attempt: 1,
          format: "json_schema",
          nodeId: "verify",
          output: {
            evidence: ["real CLI evidence present"],
            verdict: "PASS",
          },
          profile: "moka-verifier",
          schemaPath: ".pipeline/schemas/verify.schema.json",
          type: "node.output.recorded",
        });
        return applyGoalStateEvent(verified, {
          outcome: "PASS",
          type: "workflow.finish",
          workflowId: "root",
        });
      },
    });

    expect(result.terminalState).toBe("passed");
    expect(result.attempts).toBe(2);
  });

  it("does not mark passed from workflow PASS without verifier evidence", async () => {
    const state = applyGoalStateEvent(verifierFailureState({ priorAttempt: false }), {
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "root",
    });

    const result = await runBoundedGoalLoop({
      initialState: state,
      maxContinuations: 1,
      runContinuation: ({ state }) => state,
    });

    expect(result.terminalState).toBe("blocked");
    expect(result.reason).toBe("missing deterministic verifier or acceptance evidence");
  });

  it("builds continuation launch plans through the configured OpenCode runner", () => {
    const config = loadPipelineConfig(process.cwd());
    const plan = createGoalContinuationLaunchPlan({
      config,
      prompt: "Continue PIPE-52",
      worktreePath: process.cwd(),
    });

    expect(plan.runnerId).toBe("opencode");
    expect(plan.profileId).toBe("moka-code-writer");
    expect(plan.args).toContain("run");
    expect(plan.args).toContain("Continue PIPE-52");
  });
});
