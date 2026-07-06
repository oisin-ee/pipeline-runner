import { describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../../config";
import { compileWorkflowPlan } from "../../planning/compile";
import type { RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { executeDrainMergeBuiltin } from "./drain-merge";

const contextForDrainMerge = (): RuntimeContext => {
  const config = parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: a
workflows:
  default:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: command
            command: ["node", "-e", "console.log('left')"]
          - id: right
            kind: command
            command: ["node", "-e", "console.log('right')"]
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`,
    profiles: `
version: 1
profiles:
  a:
    runner: opencode
    instructions: { inline: A }
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
  });
  return {
    agentInvocations: [],
    config,
    executor: () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: ["PATH"],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    nodeStateStore: new NodeStateStore(),
    plan: compileWorkflowPlan(config),
    runId: "run-merge",
    task: "task",
    workflowId: "default",
    worktreePath: process.cwd(),
  };
};

describe("drain-merge builtin", () => {
  it("returns an empty successful report when there is no upstream node", async () => {
    const context = contextForDrainMerge();
    const result = await executeDrainMergeBuiltin(context);

    expect(result.exitCode).toBe(0);
    expect(result.evidence).toEqual(["drain-merge merged 0 branches"]);
    expect(JSON.parse(result.output)).toMatchObject({
      conflicts: [],
      integrationBranch: "runs/integration/run-merge",
      merged: [],
      skipped: [],
    });
  });

  it("skips failed children and passed children without worktrees", async () => {
    const context = contextForDrainMerge();
    const node = context.plan.graph.node("merge");
    context.nodeStateStore.lastOutputByNode.set(
      "fanout",
      JSON.stringify({
        children: {
          left: JSON.stringify({
            baseSha: null,
            branch: null,
            status: "PASS",
            worktreePath: null,
          }),
          right: JSON.stringify({
            baseSha: "base",
            branch: "right-branch",
            status: "FAIL",
            worktreePath: "/tmp/right",
          }),
        },
      }),
    );
    const result = await executeDrainMergeBuiltin(context, node);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      merged: [],
      skipped: [
        { id: "left", reason: "no-worktree", status: "PASS" },
        { id: "right", reason: "failed", status: "FAIL" },
      ],
    });
  });
});
