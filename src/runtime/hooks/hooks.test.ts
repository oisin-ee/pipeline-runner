import { afterEach, describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../../config";
import type {
  PlannedWorkflowNode,
  WorkflowExecutionPlan,
} from "../../planning/compile";
import { createDependencyGraph } from "../../planning/graph";
import type { RuntimeObservabilityEvent } from "../actor-ids";
import type {
  PipelineRuntimeEvent,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { dispatchHooks } from "./hooks";

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

const directHookRuntimeContext = (
  node: PlannedWorkflowNode,
  observability: RuntimeObservabilityEvent[],
  reporterEvents: PipelineRuntimeEvent[],
  override?: Partial<RuntimeContext>
): RuntimeContext => {
  const config = parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: direct-hooks
hooks:
  functions:
    disabled:
      command: ["disabled-hook"]
      kind: command
      trusted: true
  on:
    node.finish:
      - failure: fail
        function: disabled
        id: disabled
workflows:
  direct-hooks:
    nodes: []
`,
    profiles: `
version: 1
profiles: {}
`,
    runners: `
version: 1
runners: {}
`,
  });
  const plan: WorkflowExecutionPlan = {
    execution: { failFast: true },
    graph: createDependencyGraph([node], {
      dependenciesOf: (plannedNode) => plannedNode.needs,
      valueOf: (plannedNode) => plannedNode,
    }),
    parallelBatches: [[node]],
    topologicalOrder: [node],
    workflowId: "direct-hooks",
  };
  return {
    agentInvocations: [],
    config,
    executor: () => ({ exitCode: 0, stdout: "" }),
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
    plan,
    reporter: (event) => reporterEvents.push(event),
    runId: "run-direct",
    task: "exercise direct hook invocation",
    workflowId: "direct-hooks",
    worktreePath: process.cwd(),
    ...override,
  };
};

const reporterHookEvents = (
  events: PipelineRuntimeEvent[]
): Extract<PipelineRuntimeEvent, { hookId: string }>[] =>
  events.filter(
    (event): event is Extract<PipelineRuntimeEvent, { hookId: string }> =>
      "hookId" in event
  );

describe("runtime hooks", () => {
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

  it("matches hook bindings by workflow, node, and gate filters during dispatch", async () => {
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
    context.config.hooks.on["node.finish"] = [
      {
        failure: "fail",
        function: "disabled",
        id: "other-node",
        where: { gate: "quality", node: "node-b", workflow: "direct-hooks" },
      },
      {
        failure: "fail",
        function: "disabled",
        id: "matching",
        where: { gate: "quality", node: "node-a", workflow: "direct-hooks" },
      },
    ];

    const failure = await dispatchHooks(
      context,
      "node.finish",
      undefined,
      node,
      "quality"
    );

    expect(failure).toMatchObject({ gate: "matching" });
    expect(
      reporterHookEvents(reporterEvents).map((event) => event.hookId)
    ).toEqual(["matching", "matching"]);
  });

  it("builds command hook env from passthrough and explicit values during dispatch", async () => {
    process.env.PATH = "/bin";
    process.env.PIPELINE_TOKEN = "secret";
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
      reporterEvents,
      {
        hookPolicy: {
          allowCommandHooks: true,
          allowUntrustedCommandHooks: true,
          env: { GLOBAL_ONLY: "1" },
          envPassthrough: ["PATH"],
          outputLimitBytes: 4096,
          timeoutMs: 1000,
        },
      }
    );
    context.config.hooks.functions.env = {
      command: [
        process.execPath,
        "-e",
        [
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.PIPELINE_HOOK_RESULT, JSON.stringify({",
          "status: 'pass',",
          "outputs: {",
          "GLOBAL_ONLY: process.env.GLOBAL_ONLY,",
          "LOCAL_ONLY: process.env.LOCAL_ONLY,",
          "PATH: process.env.PATH,",
          "PIPELINE_TOKEN: process.env.PIPELINE_TOKEN,",
          "},",
          "}));",
        ].join("\n"),
      ],
      env: {
        passthrough: ["PIPELINE_TOKEN"],
        set: { LOCAL_ONLY: "1" },
      },
      kind: "command",
      protocol: { input: "file", result: "file" },
      trusted: true,
    };
    context.config.hooks.on["node.finish"] = [
      {
        failure: "fail",
        function: "env",
        id: "env",
        result: { save_as: "env" },
      },
    ];

    const failure = await dispatchHooks(
      context,
      "node.finish",
      undefined,
      node
    );

    expect(failure).toBeNull();
    expect(context.hookResults.get("env")?.outputs).toEqual({
      GLOBAL_ONLY: "1",
      LOCAL_ONLY: "1",
      PATH: "/bin",
      PIPELINE_TOKEN: "secret",
    });
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
