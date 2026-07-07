import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { executeAgentNode } from "./agent-node";

const EXCEEDS_BUDGET_RE = /exceeds 50% of every available/iu;

const agentExecutionContext = (
  node: PlannedWorkflowNode,
  executor: RuntimeContext["executor"]
): RuntimeContext => {
  const topologicalOrder = [node];
  return {
    agentInvocations: [],
    config: {
      profiles: {
        "moka-code-writer": {
          filesystem: { mode: "read-write" },
          instructions: { inline: "Write code." },
          network: { mode: "enabled" },
          output: { format: "text" },
          runner: "opencode",
          tools: [],
        },
      },
      rules: {},
      runners: {
        opencode: {
          capabilities: { output_formats: ["text"] },
          type: "opencode",
        },
      },
      skills: {},
    } as unknown as RuntimeContext["config"],
    executor,
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: [],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    nodeStateStore: new NodeStateStore({
      nodeStates: new Map([
        [
          node.id,
          {
            attempts: 0,
            evidence: [],
            gates: [],
            id: node.id,
            status: "pending",
          },
        ],
      ]),
    }),
    plan: {
      graph: { node: () => node },
      topologicalOrder,
      workflowId: "wf",
    } as unknown as RuntimeContext["plan"],
    task: "do the task",
    workflowId: "wf",
    worktreePath: process.cwd(),
  };
};

const withRuntimeConfig = (
  context: RuntimeContext,
  config: Partial<RuntimeContext["config"]>
): RuntimeContext => ({
  ...context,
  config: { ...context.config, ...config },
});

const agentNode = (): PlannedWorkflowNode =>
  ({
    children: [],
    dependents: [],
    id: "writer",
    index: 0,
    kind: "agent",
    needs: [],
    profile: "moka-code-writer",
  }) as unknown as PlannedWorkflowNode;

const openPullRequestNode = (): PlannedWorkflowNode => ({
  builtin: "open-pull-request",
  children: [],
  dependents: [],
  id: "open-pr",
  index: 1,
  kind: "builtin",
  needs: ["writer"],
});

const opencodeText = (text: string): string =>
  JSON.stringify({ part: { text, type: "text" } });

const promptFromPlan = (plan: RunnerLaunchPlan): string => {
  const dirIndex = plan.args.indexOf("--dir");
  const prompt = plan.args[dirIndex + 2];
  if (dirIndex === -1 || !prompt) {
    throw new Error("runner launch plan did not include an OpenCode prompt");
  }
  return prompt;
};

const successfulDoneExecutor = (): AgentResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ part: { text: "done", type: "text" } }),
});

const successfulSessionExecutor = (): AgentResult => ({
  exitCode: 0,
  sessionId: "ses_writer",
  stdout: JSON.stringify({
    part: { text: "done", type: "text" },
  }),
});

describe("runtime agent node", () => {
  it("records the opencode session id returned by the executor on node state", async () => {
    const node = agentNode();
    const context = agentExecutionContext(node, successfulSessionExecutor);

    const result = await executeAgentNode(node, context, 1);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("done");
    expect(
      Option.getOrUndefined(context.nodeStateStore.getNodeState("writer"))
        ?.sessionId
    ).toBe("ses_writer");
  });

  it("does not set a session id when the executor omits one", async () => {
    const node = agentNode();
    const context = agentExecutionContext(node, successfulDoneExecutor);

    await executeAgentNode(node, context, 1);

    expect(
      Option.getOrUndefined(context.nodeStateStore.getNodeState("writer"))
        ?.sessionId
    ).toBeUndefined();
  });

  it("renders canonical task context with acceptance criteria", async () => {
    const node = {
      ...agentNode(),
      taskContext: {
        acceptanceCriteria: [{ id: "A", text: "Do it" }],
        description: "Description",
        id: "PIPE-1",
        title: "Title",
      },
    };
    let prompt = "";
    const context = agentExecutionContext(node, (plan) => {
      prompt = promptFromPlan(plan);
      return { exitCode: 0, stdout: opencodeText("done") };
    });

    await executeAgentNode(node, context, 1);

    expect(prompt).toContain(
      [
        "Canonical task context:",
        "ID: PIPE-1",
        "Title: Title",
        "Description: Description",
        "Acceptance criteria:",
        "- A: Do it",
      ].join("\n")
    );
  });

  it("tells pre-delivery verifier nodes not to fail on PR absence", async () => {
    const prNode = openPullRequestNode();
    const node: PlannedWorkflowNode = {
      ...agentNode(),
      dependents: [prNode.id],
      gates: [{ id: "verdict", kind: "verdict", target: "stdout" }],
      profile: "moka-code-writer",
    };
    let prompt = "";
    const context = agentExecutionContext(node, (plan) => {
      prompt = promptFromPlan(plan);
      return { exitCode: 0, stdout: opencodeText("done") };
    });
    context.plan = {
      ...context.plan,
      topologicalOrder: [node, prNode],
    };

    await executeAgentNode(node, context, 1);

    expect(prompt).toContain("Deferred delivery checks:");
    expect(prompt).toContain(
      "Do not fail this node solely because a pull request does not exist yet."
    );
  });

  it("keeps acceptance gate prompts responsible for downstream PR acceptance", async () => {
    const prNode = openPullRequestNode();
    const node: PlannedWorkflowNode = {
      ...agentNode(),
      dependents: [prNode.id],
      gates: [{ id: "acceptance", kind: "acceptance", target: "stdout" }],
      profile: "moka-code-writer",
    };
    let prompt = "";
    const context = agentExecutionContext(node, (plan) => {
      prompt = promptFromPlan(plan);
      return { exitCode: 0, stdout: opencodeText("done") };
    });
    context.plan = {
      ...context.plan,
      topologicalOrder: [node, prNode],
    };

    await executeAgentNode(node, context, 1);

    expect(prompt).not.toContain("Deferred delivery checks:");
  });

  it("renders inherited outputs that are not direct dependencies", async () => {
    const node = {
      ...agentNode(),
      needs: ["direct"],
    };
    let prompt = "";
    const context = agentExecutionContext(node, (plan) => {
      prompt = promptFromPlan(plan);
      return { exitCode: 0, stdout: opencodeText("done") };
    });
    context.nodeStateStore = new NodeStateStore({
      inheritedOutputNodeIds: new Set(["setup", "direct"]),
      lastOutputByNode: new Map([
        ["setup", "setup output"],
        ["direct", "direct output"],
      ]),
    });

    await executeAgentNode(node, context, 1);

    expect(prompt).toContain(
      "Inherited dependency outputs:\n## setup\nsetup output"
    );
    expect(prompt).toContain("Dependency outputs:\n## direct\ndirect output");
  });

  it("renders a dependency's handoff summary in place of its raw transcript (PIPE-83.5)", async () => {
    const node = agentNode();
    let prompt = "";
    const store = new NodeStateStore({
      inheritedOutputNodeIds: new Set(["setup"]),
      lastOutputByNode: new Map([["setup", "RAW SETUP TRANSCRIPT"]]),
    });
    store.recordHandoff("setup", {
      artifacts: [{ path: "src/x.ts" }],
      decisions: ["used Effect Schema"],
      openQuestions: [],
      summary: "set up the thing",
      testNames: [],
    });
    const context = agentExecutionContext(node, (plan) => {
      prompt = promptFromPlan(plan);
      return { exitCode: 0, stdout: opencodeText("done") };
    });
    context.nodeStateStore = store;

    await executeAgentNode(node, context, 1);

    expect(prompt).toContain("## setup");
    expect(prompt).toContain("set up the thing");
    expect(prompt).toContain("- used Effect Schema");
    expect(prompt).toContain("- src/x.ts");
    expect(prompt).not.toContain("RAW SETUP TRANSCRIPT");
  });
});

describe("executeAgentNode handoff derivation (PIPE-83.1)", () => {
  it("derives no handoff when context_handoff is disabled (default)", async () => {
    const node = agentNode();
    let calls = 0;
    const executor = (): AgentResult => {
      calls += 1;
      return { exitCode: 0, stdout: opencodeText("plain output") };
    };
    const context = agentExecutionContext(node, executor);

    const result = await executeAgentNode(node, context, 1);

    expect(result.handoff).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("derives a handoff via the cheap finalizer when enabled", async () => {
    const node = agentNode();
    let calls = 0;
    const executor = (plan: RunnerLaunchPlan): AgentResult => {
      calls += 1;
      if (plan.profileId?.endsWith(":handoff") === true) {
        return {
          exitCode: 0,
          stdout: opencodeText('{"summary":"did work","decisions":["x"]}'),
        };
      }
      return { exitCode: 0, stdout: opencodeText("plain output") };
    };
    const context = withRuntimeConfig(agentExecutionContext(node, executor), {
      context_handoff: { enabled: true },
    });

    const result = await executeAgentNode(node, context, 1);

    expect(result.handoff?.summary).toBe("did work");
    expect(result.handoff?.decisions).toEqual(["x"]);
    expect(calls).toBe(2);
  });

  it("fast-paths an already-handoff-shaped output without a finalizer call", async () => {
    const node = agentNode();
    let calls = 0;
    const executor = (): AgentResult => {
      calls += 1;
      return { exitCode: 0, stdout: opencodeText('{"summary":"direct"}') };
    };
    const context = withRuntimeConfig(agentExecutionContext(node, executor), {
      context_handoff: { enabled: true },
    });

    const result = await executeAgentNode(node, context, 1);

    expect(result.handoff?.summary).toBe("direct");
    expect(calls).toBe(1);
  });

  it("falls back to a synthesized handoff when the finalizer output is unparseable", async () => {
    const node = agentNode();
    const executor = (plan: RunnerLaunchPlan): AgentResult => ({
      exitCode: 0,
      stdout: opencodeText(
        plan.profileId?.endsWith(":handoff") === true
          ? "not json"
          : "real work happened"
      ),
    });
    const context = withRuntimeConfig(agentExecutionContext(node, executor), {
      context_handoff: { enabled: true },
    });

    const result = await executeAgentNode(node, context, 1);

    expect(result.handoff?.summary).toBe("real work happened");
  });
});

const budgetNode = (models: string[]): PlannedWorkflowNode =>
  ({
    dependents: [],
    id: "green-impl",
    index: 0,
    kind: "agent",
    models,
    needs: [],
    profile: "moka-code-writer",
  }) as unknown as PlannedWorkflowNode;

const tokenBudget = (
  windows: Record<string, number>,
  defaultWindow = 200_000
): PipelineConfig["token_budget"] => ({
  default_context_window: defaultWindow,
  fan_out_width: { by_category: {}, default: 4 },
  max_context_pct: 50,
  model_context_windows: windows,
});

describe("executeAgentNode token budget enforcement", () => {
  it("fails an over-budget node with evidence and does not dispatch", async () => {
    const node = budgetNode(["small"]);
    let executed = false;
    const executor = (): AgentResult => {
      executed = true;
      return { exitCode: 0, stdout: "" };
    };
    const context = withRuntimeConfig(agentExecutionContext(node, executor), {
      token_budget: tokenBudget({}, 50),
    });

    const result = await executeAgentNode(node, context, 1);

    expect(result.exitCode).toBe(1);
    expect(result.evidence.join("\n")).toMatch(EXCEEDS_BUDGET_RE);
    expect(executed).toBe(false);
  });

  it("dispatches normally when the node fits within the cap", async () => {
    const node = budgetNode(["big"]);
    const context = withRuntimeConfig(
      agentExecutionContext(node, successfulDoneExecutor),
      {
        token_budget: tokenBudget({ big: 400_000 }),
      }
    );

    const result = await executeAgentNode(node, context, 1);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("done");
  });
});

const INFRA_EXIT = 70;

describe("executeAgentNode model fallback", () => {
  it("falls back to the next model when a session fails with an infra error", async () => {
    const node = budgetNode(["opencode-go/qwen3.7-max", "openai/gpt-5.5"]);
    const tried: Option.Option<string>[] = [];
    const executor = (plan: RunnerLaunchPlan): AgentResult => {
      tried.push(Option.fromUndefinedOr(plan.model));
      if (plan.model === "opencode-go/qwen3.7-max") {
        return {
          exitCode: INFRA_EXIT,
          stderr: "opencode session failed: {}",
          stdout: "",
        };
      }
      return { exitCode: 0, stdout: opencodeText("implemented") };
    };
    const context = agentExecutionContext(node, executor);

    const result = await executeAgentNode(node, context, 1);

    expect(tried).toEqual([
      Option.some("opencode-go/qwen3.7-max"),
      Option.some("openai/gpt-5.5"),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("implemented");
    expect(result.evidence.join("\n")).toContain(
      "model opencode-go/qwen3.7-max failed (infra exit 70"
    );
    expect(result.evidence.join("\n")).toContain(
      "model selection: openai/gpt-5.5"
    );
  });

  it("does not fall back on a genuine agent-task error (the model ran)", async () => {
    const node = budgetNode(["opencode-go/qwen3.7-max", "openai/gpt-5.5"]);
    const tried: Option.Option<string>[] = [];
    const executor = (plan: RunnerLaunchPlan): AgentResult => {
      tried.push(Option.fromUndefinedOr(plan.model));
      return { exitCode: 1, stdout: opencodeText("tried but failed") };
    };
    const context = agentExecutionContext(node, executor);

    const result = await executeAgentNode(node, context, 1);

    expect(tried).toEqual([Option.some("opencode-go/qwen3.7-max")]);
    expect(result.exitCode).toBe(1);
  });

  it("surfaces the infra failure when every candidate's session fails", async () => {
    const node = budgetNode(["opencode-go/qwen3.7-max", "openai/gpt-5.5"]);
    const tried: Option.Option<string>[] = [];
    const executor = (plan: RunnerLaunchPlan): AgentResult => {
      tried.push(Option.fromUndefinedOr(plan.model));
      return {
        exitCode: INFRA_EXIT,
        stderr: "opencode session failed: {}",
        stdout: "",
      };
    };
    const context = agentExecutionContext(node, executor);

    const result = await executeAgentNode(node, context, 1);

    expect(tried).toEqual([
      Option.some("opencode-go/qwen3.7-max"),
      Option.some("openai/gpt-5.5"),
    ]);
    expect(result.exitCode).toBe(INFRA_EXIT);
  });
});
