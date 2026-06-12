import { describe, expect, it } from "vitest";
import type { AgentResult } from "../../runner";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import type { RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import {
  executeAgentNode,
  inheritedOutputSections,
  renderTaskContext,
} from "./agent-node";

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
});
