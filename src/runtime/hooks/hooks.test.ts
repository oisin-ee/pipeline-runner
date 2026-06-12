import { afterEach, describe, expect, it } from "vitest";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import type { RuntimeObservabilityEvent } from "../actor-ids";
import type {
  HookBinding,
  HookFunctionSpec,
  PipelineRuntimeEvent,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { dispatchHooks, hookBindingMatchesContext, hookEnv } from "./hooks";

const originalPath = process.env.PATH;
const originalToken = process.env.PIPELINE_TOKEN;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalToken === undefined) {
    delete process.env.PIPELINE_TOKEN;
  } else {
    process.env.PIPELINE_TOKEN = originalToken;
  }
});

function directHookRuntimeContext(
  node: PlannedWorkflowNode,
  observability: RuntimeObservabilityEvent[],
  reporterEvents: PipelineRuntimeEvent[]
): RuntimeContext {
  return {
    agentInvocations: [],
    config: {
      default_workflow: "direct-hooks",
      hooks: {
        functions: {
          disabled: {
            command: ["disabled-hook"],
            kind: "command",
            trusted: true,
          },
        },
        on: {
          "node.finish": [
            {
              failure: "fail",
              function: "disabled",
              id: "disabled",
            },
          ],
        },
      },
      profiles: {},
      runners: {},
      version: 1,
      workflows: { "direct-hooks": { nodes: [] } },
    } as unknown as RuntimeContext["config"],
    executor: async () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: false,
      allowUntrustedCommandHooks: false,
      env: {},
      envPassthrough: [],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    nodeStateStore: new NodeStateStore(),
    observability: (event) => observability.push(event),
    plan: {
      execution: { failFast: true },
      graph: { node: () => node },
      parallelBatches: [[node]],
      topologicalOrder: [node],
      workflowId: "direct-hooks",
    } as unknown as RuntimeContext["plan"],
    reporter: (event) => reporterEvents.push(event),
    runId: "run-direct",
    task: "exercise direct hook invocation",
    workflowId: "direct-hooks",
    worktreePath: process.cwd(),
  };
}

describe("runtime hooks", () => {
  it("matches hook bindings by workflow, node, and gate filters", () => {
    const binding: HookBinding = {
      failure: "ignore",
      function: "announce",
      id: "announce",
      where: {
        gate: "quality",
        node: "node-a",
        workflow: "default",
      },
    };

    expect(
      hookBindingMatchesContext(binding, "default", "node-a", "quality")
    ).toBe(true);
    expect(
      hookBindingMatchesContext(binding, "other", "node-a", "quality")
    ).toBe(false);
    expect(
      hookBindingMatchesContext(binding, "default", "node-b", "quality")
    ).toBe(false);
    expect(
      hookBindingMatchesContext(binding, "default", "node-a", "other")
    ).toBe(false);
  });

  it("builds command hook env from passthrough and explicit values", () => {
    process.env.PATH = "/bin";
    process.env.PIPELINE_TOKEN = "secret";
    const hook: Extract<HookFunctionSpec, { kind: "command" }> = {
      command: ["hook-bin"],
      env: {
        passthrough: ["PIPELINE_TOKEN"],
        set: { LOCAL_ONLY: "1" },
      },
      kind: "command",
      protocol: { input: "file", result: "file" },
      trusted: true,
    };
    const context = {
      hookPolicy: {
        allowCommandHooks: true,
        allowUntrustedCommandHooks: true,
        env: { GLOBAL_ONLY: "1" },
        envPassthrough: ["PATH"],
        outputLimitBytes: 1024,
        timeoutMs: 1000,
      },
    } as Pick<RuntimeContext, "hookPolicy">;

    expect(hookEnv(hook, context)).toEqual({
      GLOBAL_ONLY: "1",
      LOCAL_ONLY: "1",
      PATH: "/bin",
      PIPELINE_TOKEN: "secret",
    });
  });

  it("dispatches hooks directly while preserving failure and observability contracts", async () => {
    const node: PlannedWorkflowNode = {
      dependents: [],
      id: "node-a",
      index: 0,
      kind: "agent",
      needs: [],
    };
    const observability: RuntimeObservabilityEvent[] = [];
    const reporterEvents: PipelineRuntimeEvent[] = [];
    const context = directHookRuntimeContext(
      node,
      observability,
      reporterEvents
    );

    const failure = await dispatchHooks(
      context,
      "node.finish",
      undefined,
      node
    );

    const expectedFailure: RuntimeFailure = {
      evidence: ["command hooks are disabled"],
      gate: "disabled",
      nodeId: "node-a",
      reason: "hook 'disabled' failed",
    };
    expect(failure).toEqual(expectedFailure);
    expect(context.hookFailures).toEqual([expectedFailure]);
    expect(reporterEvents).toEqual([
      {
        event: "node.finish",
        functionId: "disabled",
        hookId: "disabled",
        nodeId: "node-a",
        required: true,
        type: "hook.start",
        workflowId: "direct-hooks",
      },
      {
        event: "node.finish",
        functionId: "disabled",
        hookId: "disabled",
        nodeId: "node-a",
        passed: false,
        reason: "hook 'disabled' failed",
        required: true,
        type: "hook.finish",
        workflowId: "direct-hooks",
      },
    ]);
    expect(observability).toEqual([
      expect.objectContaining({
        actor: {
          id: "pipeline.hook.run-direct.direct-hooks.node-a.disabled",
          kind: "hook",
          systemId: "pipeline.pipeline.run-direct.direct-hooks",
        },
        hookId: "disabled",
        nodeId: "node-a",
        type: "runtime.hook.started",
      }),
      expect.objectContaining({
        hookId: "disabled",
        nodeId: "node-a",
        passed: false,
        reason: "hook 'disabled' failed",
        type: "runtime.hook.finished",
      }),
      expect.objectContaining({
        hookId: "disabled",
        nodeId: "node-a",
        reason: "hook 'disabled' failed",
        type: "runtime.hook.failed",
      }),
    ]);
    expect(JSON.stringify(observability)).not.toContain("snapshot");
  });

  it("emits skipped hook observability when cancellation prevents invocation", async () => {
    const node: PlannedWorkflowNode = {
      dependents: [],
      id: "node-a",
      index: 0,
      kind: "agent",
      needs: [],
    };
    const observability: RuntimeObservabilityEvent[] = [];
    const reporterEvents: PipelineRuntimeEvent[] = [];
    const context = directHookRuntimeContext(
      node,
      observability,
      reporterEvents
    );
    const abortController = new AbortController();
    abortController.abort();
    context.signal = abortController.signal;

    const failure = await dispatchHooks(
      context,
      "node.finish",
      undefined,
      node
    );

    expect(failure).toBeNull();
    expect(context.hookFailures).toEqual([]);
    expect(reporterEvents).toEqual([]);
    expect(observability).toEqual([
      expect.objectContaining({
        actor: {
          id: "pipeline.hook.run-direct.direct-hooks.node-a.disabled",
          kind: "hook",
          systemId: "pipeline.pipeline.run-direct.direct-hooks",
        },
        hookId: "disabled",
        nodeId: "node-a",
        reason: "hook cancelled",
        type: "runtime.hook.skipped",
      }),
    ]);
  });
});
