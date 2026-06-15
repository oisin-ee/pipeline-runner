import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import {
  executeAgentNode,
  inheritedOutputSections,
  renderTaskContext,
} from "./agent-node";

const EXCEEDS_BUDGET_RE = /exceeds 50% of every available/i;

function agentExecutionContext(
  node: PlannedWorkflowNode,
  executor: RuntimeContext["executor"]
): RuntimeContext {
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
      topologicalOrder: [node],
      workflowId: "wf",
    } as unknown as RuntimeContext["plan"],
    task: "do the task",
    workflowId: "wf",
    worktreePath: process.cwd(),
  };
}

function agentNode(): PlannedWorkflowNode {
  return {
    children: [],
    dependents: [],
    id: "writer",
    index: 0,
    kind: "agent",
    needs: [],
    profile: "moka-code-writer",
  } as unknown as PlannedWorkflowNode;
}

describe("runtime agent node", () => {
  it("records the opencode session id returned by the executor on node state", async () => {
    const node = agentNode();
    const executor = (): AgentResult => ({
      exitCode: 0,
      sessionId: "ses_writer",
      stdout: JSON.stringify({
        part: { text: "done", type: "text" },
      }),
    });
    const context = agentExecutionContext(node, executor);

    const result = await executeAgentNode(node, context, 1);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("done");
    expect(context.nodeStateStore.getNodeState("writer")?.sessionId).toBe(
      "ses_writer"
    );
  });

  it("does not set a session id when the executor omits one", async () => {
    const node = agentNode();
    const executor = (): AgentResult => ({
      exitCode: 0,
      stdout: JSON.stringify({ part: { text: "done", type: "text" } }),
    });
    const context = agentExecutionContext(node, executor);

    await executeAgentNode(node, context, 1);

    expect(
      context.nodeStateStore.getNodeState("writer")?.sessionId
    ).toBeUndefined();
  });

  it("renders canonical task context with acceptance criteria", () => {
    expect(
      renderTaskContext({
        acceptanceCriteria: [{ id: "A", text: "Do it" }],
        description: "Description",
        id: "PIPE-1",
        title: "Title",
      })
    ).toBe(
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

  it("renders inherited outputs that are not direct dependencies", () => {
    const context = {
      nodeStateStore: new NodeStateStore({
        inheritedOutputNodeIds: new Set(["setup", "direct"]),
        lastOutputByNode: new Map([
          ["setup", "setup output"],
          ["direct", "direct output"],
        ]),
      }),
    } satisfies Pick<RuntimeContext, "nodeStateStore">;

    expect(
      inheritedOutputSections(
        {
          children: [],
          dependents: [],
          id: "agent",
          index: 0,
          kind: "agent",
          needs: ["direct"],
          profile: "a",
        },
        context
      )
    ).toEqual(["Inherited dependency outputs:", "## setup\nsetup output", ""]);
  });

  it("renders a dependency's handoff summary in place of its raw transcript (PIPE-83.5)", () => {
    const store = new NodeStateStore({
      inheritedOutputNodeIds: new Set(["setup"]),
      lastOutputByNode: new Map([["setup", "RAW SETUP TRANSCRIPT"]]),
    });
    store.recordHandoff("setup", {
      artifacts: [{ path: "src/x.ts" }],
      decisions: ["used zod"],
      openQuestions: [],
      summary: "set up the thing",
      testNames: [],
    });

    const text = inheritedOutputSections(
      {
        children: [],
        dependents: [],
        id: "agent",
        index: 0,
        kind: "agent",
        needs: [],
        profile: "a",
      } as unknown as PlannedWorkflowNode,
      { nodeStateStore: store }
    ).join("\n");

    expect(text).toContain("## setup");
    expect(text).toContain("set up the thing");
    expect(text).toContain("- used zod");
    expect(text).toContain("- src/x.ts");
    expect(text).not.toContain("RAW SETUP TRANSCRIPT");
  });
});

function opencodeText(text: string): string {
  return JSON.stringify({ part: { text, type: "text" } });
}

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
      if (plan.profileId?.endsWith(":handoff")) {
        return {
          exitCode: 0,
          stdout: opencodeText('{"summary":"did work","decisions":["x"]}'),
        };
      }
      return { exitCode: 0, stdout: opencodeText("plain output") };
    };
    const context = agentExecutionContext(node, executor);
    context.config.context_handoff = { enabled: true };

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
    const context = agentExecutionContext(node, executor);
    context.config.context_handoff = { enabled: true };

    const result = await executeAgentNode(node, context, 1);

    expect(result.handoff?.summary).toBe("direct");
    expect(calls).toBe(1);
  });

  it("falls back to a synthesized handoff when the finalizer output is unparseable", async () => {
    const node = agentNode();
    const executor = (plan: RunnerLaunchPlan): AgentResult => ({
      exitCode: 0,
      stdout: opencodeText(
        plan.profileId?.endsWith(":handoff") ? "not json" : "real work happened"
      ),
    });
    const context = agentExecutionContext(node, executor);
    context.config.context_handoff = { enabled: true };

    const result = await executeAgentNode(node, context, 1);

    expect(result.handoff?.summary).toBe("real work happened");
  });
});

function budgetNode(models: string[]): PlannedWorkflowNode {
  return {
    dependents: [],
    id: "green-impl",
    index: 0,
    kind: "agent",
    models,
    needs: [],
    profile: "moka-code-writer",
  } as unknown as PlannedWorkflowNode;
}

function tokenBudget(
  windows: Record<string, number>,
  defaultWindow = 200_000
): PipelineConfig["token_budget"] {
  return {
    default_context_window: defaultWindow,
    fan_out_width: { by_category: {}, default: 4 },
    max_context_pct: 50,
    model_context_windows: windows,
  };
}

describe("executeAgentNode token budget enforcement", () => {
  it("fails an over-budget node with evidence and does not dispatch", async () => {
    const node = budgetNode(["small"]);
    let executed = false;
    const executor = (): AgentResult => {
      executed = true;
      return { exitCode: 0, stdout: "" };
    };
    const context = agentExecutionContext(node, executor);
    context.config.token_budget = tokenBudget({}, 50); // tiny window

    const result = await executeAgentNode(node, context, 1);

    expect(result.exitCode).toBe(1);
    expect(result.evidence.join("\n")).toMatch(EXCEEDS_BUDGET_RE);
    expect(executed).toBe(false);
  });

  it("dispatches normally when the node fits within the cap", async () => {
    const node = budgetNode(["big"]);
    const executor = (): AgentResult => ({
      exitCode: 0,
      stdout: JSON.stringify({ part: { text: "done", type: "text" } }),
    });
    const context = agentExecutionContext(node, executor);
    context.config.token_budget = tokenBudget({ big: 400_000 });

    const result = await executeAgentNode(node, context, 1);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("done");
  });
});
