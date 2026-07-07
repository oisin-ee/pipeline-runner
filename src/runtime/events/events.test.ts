import { describe, expect, it } from "@effect/vitest";

import { parsePipelineConfigParts } from "../../config";
import { compileWorkflowPlan } from "../../planning/compile";
import type { PipelineRuntimeEvent, RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import {
  childReporter,
  createPublicRuntimeObservabilityEmitter,
  emitNodeOutputRecorded,
  emitWorkflowPlanned,
  runtimeNodeActorDescriptor,
} from "./events";

const runtimeContextForEvents = (
  reporter: (event: PipelineRuntimeEvent) => void
): RuntimeContext => {
  const config = parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: structured
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: structured
      - id: b
        kind: command
        needs: [a]
        command: ["node", "-e", "console.log('ok')"]
`,
    profiles: `
version: 1
profiles:
  structured:
    runner: opencode
    instructions: { inline: Structured }
    output:
      format: json_schema
      schema_path: schema.json
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text, json, json_schema]
`,
  });
  const plan = compileWorkflowPlan(config);
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
    plan,
    reporter,
    task: "test",
    workflowId: "default",
    worktreePath: process.cwd(),
  };
};

describe("runtime events", () => {
  it("emits planned workflow nodes with runner metadata", () => {
    const events: PipelineRuntimeEvent[] = [];
    const context = runtimeContextForEvents((event) => {
      events.push(event);
    });

    emitWorkflowPlanned(context);

    expect(events).toEqual([
      {
        edges: [{ source: "a", target: "b" }],
        nodes: [
          {
            id: "a",
            kind: "agent",
            needs: [],
            profile: "structured",
            runnerId: "opencode",
          },
          { id: "b", kind: "command", needs: ["a"] },
        ],
        type: "workflow.planned",
        workflowId: "default",
      },
    ]);
  });

  it("records structured node output in reporter events", () => {
    const events: PipelineRuntimeEvent[] = [];
    const context = runtimeContextForEvents((event) => {
      events.push(event);
    });
    const node = context.plan.graph.node("a");
    expect(node).toBeDefined();

    emitNodeOutputRecorded(context, node, 2, `{"verdict":"PASS"}`);

    expect(events).toEqual([
      {
        attempt: 2,
        format: "json_schema",
        nodeId: "a",
        output: { verdict: "PASS" },
        profile: "structured",
        schemaPath: "schema.json",
        type: "node.output.recorded",
      },
    ]);
  });

  it("prefixes nested child events consistently", () => {
    const events: PipelineRuntimeEvent[] = [];
    const reporter = childReporter(
      runtimeContextForEvents((event) => {
        events.push(event);
      }),
      "parent"
    );

    reporter?.({
      edges: [{ source: "a", target: "b" }],
      nodes: [
        { id: "a", kind: "agent", needs: [] },
        { id: "b", kind: "command", needs: ["a"] },
      ],
      type: "workflow.planned",
      workflowId: "child",
    });

    expect(events).toEqual([
      {
        edges: [{ source: "parent.a", target: "parent.b" }],
        nodes: [
          { id: "parent.a", kind: "agent", needs: [] },
          { id: "parent.b", kind: "command", needs: ["a"] },
        ],
        parentNodeId: "parent",
        type: "workflow.planned",
        workflowId: "child",
      },
    ]);
  });

  it("maps runtime observability events to public reporter events", () => {
    const events: PipelineRuntimeEvent[] = [];
    const actor = runtimeNodeActorDescriptor(
      runtimeContextForEvents((event) => {
        events.push(event);
      }),
      "node-a"
    );
    const emit = createPublicRuntimeObservabilityEmitter((event) => {
      events.push(event);
    }, "default");

    emit({
      actor,
      attempt: 3,
      nodeId: "node-a",
      reason: "gate_failure",
      timestamp: "2026-06-04T00:00:00.000Z",
      type: "runtime.retry.exhausted",
    });

    expect(events).toEqual([
      {
        actor,
        level: "warn",
        name: "runtime.retry.exhausted",
        nodeId: "node-a",
        summary: "node node-a retry exhausted after attempt 3 (gate_failure)",
        type: "runtime.observability",
        workflowId: "default",
      },
    ]);
  });
});
