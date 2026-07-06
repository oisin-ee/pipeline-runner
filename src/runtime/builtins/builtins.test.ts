import { describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../../config";
import { compileWorkflowPlan } from "../../planning/compile";
import type { RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { executeBuiltin } from "./builtins";

const contextForBuiltins = (): RuntimeContext => {
  const config = parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: a
workflows:
  default:
    nodes:
      - id: merge
        kind: builtin
        builtin: drain-merge
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
    runId: "run-builtins",
    task: "task",
    workflowId: "default",
    worktreePath: process.cwd(),
  };
};

describe("runtime builtins", () => {
  it("fails unsupported builtins with evidence", async () => {
    await expect(executeBuiltin("missing", contextForBuiltins())).resolves.toEqual({
      evidence: ["unsupported builtin 'missing'"],
      exitCode: 1,
      output: "",
    });
  });

  it("delegates drain-merge to the drain merge builtin", async () => {
    const context = contextForBuiltins();
    const node = context.plan.graph.node("merge");
    if (!node) {
      throw new Error("expected merge node");
    }

    const result = await executeBuiltin("drain-merge", context, node);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      integrationBranch: "runs/integration/run-builtins",
    });
  });

  it("delegates open-pull-request to the open-pull-request builtin", async () => {
    // Use a non-git directory so git operations fail fast (no network).
    const context = { ...contextForBuiltins(), worktreePath: "/tmp" };

    const result = await executeBuiltin("open-pull-request", context);

    // The builtin dispatches — it does not return "unsupported builtin".
    // It fails because /tmp is not a git repo, but the dispatch path ran.
    expect(result.evidence[0]).not.toBe("unsupported builtin 'open-pull-request'");
    expect(result.exitCode).toBe(1);
  });
});
