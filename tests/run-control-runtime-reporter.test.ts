import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
} from "../src/pipeline-runtime";
import type { MokaRunEvent } from "../src/run-control/contracts";
import { createRun, readRun } from "../src/run-control/store";

type RuntimeReporter = NonNullable<PipelineRuntimeOptions["reporter"]>;

interface RunStoreRuntimeReporter {
  flush: () => Promise<void>;
  reporter: RuntimeReporter;
}

interface RunStoreRuntimeReporterModule {
  createRunStoreRuntimeReporter: (input: {
    now?: () => Date;
    reporter?: PipelineRuntimeOptions["reporter"];
    runId: string;
    workspaceRoot: string;
  }) => RunStoreRuntimeReporter;
}

const RUNTIME_REPORTER_MODULE_PATH = "../src/run-control/runtime-reporter";

async function loadRuntimeReporter(): Promise<RunStoreRuntimeReporterModule> {
  return (await import(
    RUNTIME_REPORTER_MODULE_PATH
  )) as RunStoreRuntimeReporterModule;
}

function runPath(workspaceRoot: string, runId: string, ...parts: string[]) {
  return join(workspaceRoot, ".pipeline", "runs", runId, ...parts);
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sequentialClock(): () => Date {
  let seconds = 0;
  return () => {
    const next = new Date(Date.UTC(2026, 5, 17, 12, 0, seconds));
    seconds += 1;
    return next;
  };
}

function statusProjection(event: MokaRunEvent) {
  if (event.type === "run.status") {
    return {
      status: event.status,
      type: event.type,
    };
  }

  return {
    nodeId: event.nodeId,
    status: event.status,
    type: event.type,
  };
}

describe("run-control runtime reporter bridge", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "pipeline-runtime-reporter-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("forwards PipelineRuntimeEvents and persists the exact runtime stream", async () => {
    const { createRunStoreRuntimeReporter } = await loadRuntimeReporter();
    const runId = "run-forwarding";
    await createRun({
      effort: "quick",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const forwardedEvents: PipelineRuntimeEvent[] = [];
    const bridge = createRunStoreRuntimeReporter({
      now: sequentialClock(),
      reporter: (event) => forwardedEvents.push(event),
      runId,
      workspaceRoot,
    });
    const runtimeEvents: PipelineRuntimeEvent[] = [
      {
        edges: [],
        nodes: [
          {
            id: "writer",
            kind: "agent",
            needs: [],
            profile: "code-writer",
            runnerId: "opencode",
          },
        ],
        type: "workflow.planned",
        workflowId: "runtime-bridge",
      },
      {
        nodeIds: ["writer"],
        type: "workflow.start",
        workflowId: "runtime-bridge",
      },
      {
        attempt: 1,
        nodeId: "writer",
        passed: false,
        reason: "invalid structured output",
        type: "output.repair",
      },
      {
        outcome: "PASS",
        type: "workflow.finish",
        workflowId: "runtime-bridge",
      },
    ];

    for (const event of runtimeEvents) {
      bridge.reporter(event);
    }

    expect(forwardedEvents).toEqual(runtimeEvents);

    await bridge.flush();

    expect(
      readJsonl(runPath(workspaceRoot, runId, "runtime-events.jsonl"))
    ).toEqual(runtimeEvents);
  });

  it("projects workflow, node, agent, gate, and hook events into run store statuses", async () => {
    const { createRunStoreRuntimeReporter } = await loadRuntimeReporter();
    const runId = "run-status-projections";
    await createRun({
      effort: "normal",
      mode: "write",
      nodeIds: ["agent", "gated", "hooked", "writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const bridge = createRunStoreRuntimeReporter({
      now: sequentialClock(),
      runId,
      workspaceRoot,
    });
    const runtimeEvents: PipelineRuntimeEvent[] = [
      {
        nodeIds: ["writer", "agent", "gated", "hooked"],
        type: "workflow.start",
        workflowId: "runtime-bridge",
      },
      {
        attempt: 1,
        nodeId: "writer",
        profile: "code-writer",
        runnerId: "opencode",
        type: "node.start",
      },
      {
        attempt: 1,
        nodeId: "agent",
        profile: "code-writer",
        runnerId: "opencode",
        type: "agent.start",
      },
      {
        attempt: 1,
        exitCode: 1,
        nodeId: "agent",
        profile: "code-writer",
        runnerId: "opencode",
        type: "agent.finish",
      },
      {
        gateId: "acceptance",
        kind: "acceptance",
        nodeId: "gated",
        type: "gate.start",
      },
      {
        evidence: ["criterion failed"],
        gateId: "acceptance",
        kind: "acceptance",
        nodeId: "gated",
        passed: false,
        reason: "acceptance rejected output",
        type: "gate.finish",
      },
      {
        event: "node.finish",
        functionId: "notify",
        hookId: "notify-hooked",
        nodeId: "hooked",
        required: true,
        type: "hook.start",
        workflowId: "runtime-bridge",
      },
      {
        event: "node.finish",
        functionId: "notify",
        hookId: "notify-hooked",
        nodeId: "hooked",
        passed: false,
        reason: "required hook failed",
        required: true,
        type: "hook.finish",
        workflowId: "runtime-bridge",
      },
      {
        attempt: 1,
        exitCode: 0,
        nodeId: "writer",
        profile: "code-writer",
        runnerId: "opencode",
        status: "passed",
        type: "node.finish",
      },
      {
        outcome: "FAIL",
        type: "workflow.finish",
        workflowId: "runtime-bridge",
      },
    ];

    for (const event of runtimeEvents) {
      bridge.reporter(event);
    }
    await bridge.flush();

    const run = await readRun({ runId, workspaceRoot });
    expect(run).toMatchObject({
      nodes: {
        agent: "failed",
        gated: "blocked",
        hooked: "blocked",
        writer: "passed",
      },
      status: "failed",
    });
    expect(run?.events.map(statusProjection)).toEqual([
      { status: "starting", type: "run.status" },
      { nodeId: "writer", status: "running", type: "node.status" },
      { nodeId: "agent", status: "running", type: "node.status" },
      { nodeId: "agent", status: "failed", type: "node.status" },
      { nodeId: "gated", status: "running", type: "node.status" },
      { nodeId: "gated", status: "blocked", type: "node.status" },
      { nodeId: "hooked", status: "running", type: "node.status" },
      { nodeId: "hooked", status: "blocked", type: "node.status" },
      { nodeId: "writer", status: "passed", type: "node.status" },
      { status: "failed", type: "run.status" },
    ]);
  });

  it("appends node output chunks to the node stdout artifact", async () => {
    const { createRunStoreRuntimeReporter } = await loadRuntimeReporter();
    const runId = "run-output-artifacts";
    await createRun({
      effort: "quick",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const bridge = createRunStoreRuntimeReporter({
      now: sequentialClock(),
      runId,
      workspaceRoot,
    });
    const outputEvents: PipelineRuntimeEvent[] = [
      {
        attempt: 1,
        format: "text",
        nodeId: "writer",
        output: "first chunk\n",
        profile: "code-writer",
        type: "node.output.recorded",
      },
      {
        attempt: 2,
        format: "json",
        nodeId: "writer",
        output: { ok: true },
        profile: "code-writer",
        type: "node.output.recorded",
      },
    ];

    for (const event of outputEvents) {
      bridge.reporter(event);
    }
    await bridge.flush();

    expect(
      readJsonl(
        runPath(workspaceRoot, runId, "nodes", "writer", "stdout.jsonl")
      )
    ).toEqual(outputEvents);
    expect(
      readJsonl(runPath(workspaceRoot, runId, "runtime-events.jsonl"))
    ).toEqual(outputEvents);
  });

  it("persists OpenCode session ids as per-node metadata in run status", async () => {
    const { createRunStoreRuntimeReporter } = await loadRuntimeReporter();
    const runId = "run-opencode-session-metadata";
    await createRun({
      effort: "quick",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const bridge = createRunStoreRuntimeReporter({
      now: sequentialClock(),
      runId,
      workspaceRoot,
    });
    const sessionEvent = {
      nodeId: "writer",
      sessionId: "ses_writer",
      type: "node.session",
    } as unknown as PipelineRuntimeEvent;

    bridge.reporter({
      nodeIds: ["writer"],
      type: "workflow.start",
      workflowId: "runtime-bridge",
    });
    bridge.reporter(sessionEvent);
    bridge.reporter({
      attempt: 1,
      exitCode: 0,
      nodeId: "writer",
      profile: "code-writer",
      runnerId: "opencode",
      status: "passed",
      type: "node.finish",
    });
    bridge.reporter({
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "runtime-bridge",
    });
    await bridge.flush();

    expect(readJson(runPath(workspaceRoot, runId, "status.json"))).toEqual({
      nodes: {
        writer: {
          sessionId: "ses_writer",
          status: "passed",
        },
      },
      status: "passed",
    });
    expect(
      readJsonl(runPath(workspaceRoot, runId, "runtime-events.jsonl"))
    ).toContainEqual(sessionEvent);
  });
});
