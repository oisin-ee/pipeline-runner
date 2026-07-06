import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PipelineRuntimeEvent, PipelineRuntimeOptions } from "../src/pipeline-runtime";
import type { MokaRunEvent } from "../src/run-control/contracts";
import { fileRunControlStore } from "../src/run-control/run-control-store";
import { createRun, readRun } from "./run-control-file-store-helpers";
import { readJson, readJsonl, runPath } from "./run-control-test-helpers";

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
    store: ReturnType<typeof fileRunControlStore>;
    workspaceRoot: string;
  }) => RunStoreRuntimeReporter;
}

const RUNTIME_REPORTER_MODULE_PATH = "../src/run-control/runtime-reporter";

const loadRuntimeReporter = async (): Promise<RunStoreRuntimeReporterModule> =>
  (await import(RUNTIME_REPORTER_MODULE_PATH)) as RunStoreRuntimeReporterModule;

const sequentialClock = (): (() => Date) => {
  let seconds = 0;
  return () => {
    const next = new Date(Date.UTC(2026, 5, 17, 12, 0, seconds));
    seconds += 1;
    return next;
  };
};

const statusProjection = (event: MokaRunEvent) => {
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
};

describe("run-control runtime reporter bridge", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "pipeline-runtime-reporter-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("serializes run-state persistence against a builtin hide window so the run survives parallel mechanical-checks", async () => {
    const { createRunStoreRuntimeReporter } = await loadRuntimeReporter();
    const { acquireRunStateLock } = await import("../src/run-control/run-state-lock");
    const runId = "run-hide-window";
    await createRun({
      effort: "normal",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const bridge = createRunStoreRuntimeReporter({
      now: sequentialClock(),
      runId,
      store: fileRunControlStore(workspaceRoot),
      workspaceRoot,
    });

    const runsDir = join(workspaceRoot, ".pipeline", "runs");
    const hiddenDir = join(workspaceRoot, ".pipeline", ".runs-hidden-test");

    // Reproduce the builtin lint/fallow hide: hold the run-state lock and
    // relocate .pipeline/runs while a sibling node persists its status.
    const release = await acquireRunStateLock();
    renameSync(runsDir, hiddenDir);

    bridge.reporter({
      nodeIds: ["writer"],
      type: "workflow.start",
      workflowId: "hide-window",
    });
    // Persistence must queue behind the lock, not run against the missing dir.
    await new Promise((resolve) => setTimeout(resolve, 20));

    renameSync(hiddenDir, runsDir);
    release();

    // Without the lock this flush rejects with "Run ... does not exist".
    await expect(bridge.flush()).resolves.toBeUndefined();
    const status = readJson(runPath(workspaceRoot, runId, "status.json")) as {
      status: string;
    };
    expect(status.status).toBe("starting");
  });

  it("keeps the run alive when an internal sub-invocation reports a session for an undeclared node", async () => {
    const { createRunStoreRuntimeReporter } = await loadRuntimeReporter();
    const runId = "run-handoff-session";
    await createRun({
      effort: "normal",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const bridge = createRunStoreRuntimeReporter({
      now: sequentialClock(),
      runId,
      store: fileRunControlStore(workspaceRoot),
      workspaceRoot,
    });

    bridge.reporter({
      nodeIds: ["writer"],
      type: "workflow.start",
      workflowId: "handoff",
    });
    // The `<node>:handoff` finalizer is an internal sub-invocation, not a
    // declared run node; persisting its session fails in the store, but that
    // must be skipped (best-effort observability), not abort the run on flush.
    bridge.reporter({
      nodeId: "writer:handoff",
      sessionId: "ses_handoff",
      type: "node.session",
    });
    await expect(bridge.flush()).resolves.toBeUndefined();

    // The declared node's own session still records.
    bridge.reporter({
      nodeId: "writer",
      sessionId: "ses_writer",
      type: "node.session",
    });
    await expect(bridge.flush()).resolves.toBeUndefined();
    const status = readJson(runPath(workspaceRoot, runId, "status.json")) as {
      nodes: Record<string, { sessionId?: string }>;
    };
    expect(status.nodes.writer.sessionId).toBe("ses_writer");
    expect(status.nodes["writer:handoff"]).toBeUndefined();
  });

  it("documents the hazard: a direct run-state write during a hide window fails", async () => {
    const { updateRunStatus } = await import("./run-control-file-store-helpers");
    const runId = "run-hide-hazard";
    await createRun({
      effort: "normal",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const runsDir = join(workspaceRoot, ".pipeline", "runs");
    const hiddenDir = join(workspaceRoot, ".pipeline", ".runs-hidden-hazard");

    renameSync(runsDir, hiddenDir);
    await expect(
      updateRunStatus({
        at: new Date(Date.UTC(2026, 5, 17, 12, 0, 0)).toISOString(),
        runId,
        status: "running",
        workspaceRoot,
      }),
    ).rejects.toThrow("does not exist");
    renameSync(hiddenDir, runsDir);
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
      store: fileRunControlStore(workspaceRoot),
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

    expect(readJsonl(runPath(workspaceRoot, runId, "runtime-events.jsonl"))).toEqual(runtimeEvents);
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
      store: fileRunControlStore(workspaceRoot),
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
      store: fileRunControlStore(workspaceRoot),
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

    expect(readJsonl(runPath(workspaceRoot, runId, "nodes", "writer", "stdout.jsonl"))).toEqual(outputEvents);
    expect(readJsonl(runPath(workspaceRoot, runId, "runtime-events.jsonl"))).toEqual(outputEvents);
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
      store: fileRunControlStore(workspaceRoot),
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
    expect(readJsonl(runPath(workspaceRoot, runId, "runtime-events.jsonl"))).toContainEqual(sessionEvent);
  });
});
