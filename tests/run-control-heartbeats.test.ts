import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
} from "../src/pipeline-runtime";
import { createRun, readRun } from "../src/run-control/store";

type RuntimeReporter = NonNullable<PipelineRuntimeOptions["reporter"]>;

interface RunControlSupervisor {
  flush: () => Promise<void>;
  reporter: RuntimeReporter;
  start: () => void;
  stop: () => Promise<void> | void;
}

interface RunControlSupervisorModule {
  createRunControlSupervisor: (input: {
    heartbeatIntervalMs?: number;
    nodeStaleAfterMs?: number;
    now?: () => Date;
    runId: string;
    workspaceRoot: string;
  }) => RunControlSupervisor;
}

interface RunControlContractsModule {
  DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS?: unknown;
  DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS?: unknown;
  safeParseMokaRunEvent?: (input: unknown) => { success: boolean };
  safeParseMokaRunManifest?: (input: unknown) => { success: boolean };
}

const RUN_CONTROL_SUPERVISOR_MODULE_PATH = "../src/run-control/supervisor";
const RUN_CONTROL_CONTRACTS_MODULE_PATH = "../src/run-control/contracts";

async function loadSupervisor(): Promise<RunControlSupervisorModule> {
  return (await import(
    RUN_CONTROL_SUPERVISOR_MODULE_PATH
  )) as RunControlSupervisorModule;
}

async function loadContracts(): Promise<RunControlContractsModule> {
  return (await import(
    RUN_CONTROL_CONTRACTS_MODULE_PATH
  )) as RunControlContractsModule;
}

function runPath(workspaceRoot: string, runId: string, ...parts: string[]) {
  return join(workspaceRoot, ".pipeline", "runs", runId, ...parts);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readRunControlEvents(workspaceRoot: string, runId: string) {
  return readJsonl(runPath(workspaceRoot, runId, "events.jsonl"));
}

function heartbeatEvents(workspaceRoot: string, runId: string) {
  return readRunControlEvents(workspaceRoot, runId).filter(
    (event) => event.type === "run.heartbeat"
  );
}

function positiveNamedDefault(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Expected run-control default to be exported as a number.");
  }
  const numberValue = value as number;
  if (!(Number.isInteger(numberValue) && numberValue > 0)) {
    throw new Error("Expected run-control default to be a positive integer.");
  }
  return numberValue;
}

describe("run-control heartbeats and stale detection", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "moka-run-control-heartbeats-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("emits run heartbeat events at the configured fixed interval while active", async () => {
    const { createRunControlSupervisor } = await loadSupervisor();
    const runId = "run-heartbeat-fixed-interval";
    await createRun({
      effort: "quick",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const supervisor = createRunControlSupervisor({
      heartbeatIntervalMs: 5000,
      nodeStaleAfterMs: 60_000,
      now: () => new Date(Date.now()),
      runId,
      workspaceRoot,
    });

    supervisor.start();
    supervisor.reporter({
      nodeIds: ["writer"],
      type: "workflow.start",
      workflowId: "heartbeat-workflow",
    });
    await supervisor.flush();

    await vi.advanceTimersByTimeAsync(4999);
    await supervisor.flush();
    expect(heartbeatEvents(workspaceRoot, runId)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await supervisor.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await supervisor.flush();

    expect(heartbeatEvents(workspaceRoot, runId)).toEqual([
      {
        at: "2026-06-17T12:00:05.000Z",
        heartbeatIntervalMs: 5000,
        type: "run.heartbeat",
      },
      {
        at: "2026-06-17T12:00:10.000Z",
        heartbeatIntervalMs: 5000,
        type: "run.heartbeat",
      },
    ]);

    supervisor.reporter({
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "heartbeat-workflow",
    });
    await supervisor.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await supervisor.flush();
    await supervisor.stop();

    expect(heartbeatEvents(workspaceRoot, runId)).toHaveLength(2);
  });

  it("marks a silent active node stalled after the configured threshold without killing it", async () => {
    const { createRunControlSupervisor } = await loadSupervisor();
    const runId = "run-stale-node-transition";
    await createRun({
      effort: "quick",
      mode: "write",
      nodeIds: ["writer"],
      runId,
      target: "local",
      workspaceRoot,
    });
    const supervisor = createRunControlSupervisor({
      heartbeatIntervalMs: 10_000,
      nodeStaleAfterMs: 30_000,
      now: () => new Date(Date.now()),
      runId,
      workspaceRoot,
    });

    supervisor.start();
    const runtimeEvents: PipelineRuntimeEvent[] = [
      {
        nodeIds: ["writer"],
        type: "workflow.start",
        workflowId: "stale-workflow",
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
        format: "text",
        nodeId: "writer",
        output: "initial OpenCode output\n",
        profile: "code-writer",
        type: "node.output.recorded",
      },
    ];

    for (const event of runtimeEvents) {
      supervisor.reporter(event);
    }
    await supervisor.flush();

    await vi.advanceTimersByTimeAsync(20_000);
    supervisor.reporter({
      attempt: 1,
      format: "text",
      nodeId: "writer",
      output: "fresh runtime output resets the stale deadline\n",
      profile: "code-writer",
      type: "node.output.recorded",
    });
    await supervisor.flush();

    await vi.advanceTimersByTimeAsync(29_999);
    await supervisor.flush();
    expect(await readRun({ runId, workspaceRoot })).toMatchObject({
      nodes: { writer: "running" },
    });

    await vi.advanceTimersByTimeAsync(1);
    await supervisor.flush();

    const stalledRun = await readRun({ runId, workspaceRoot });
    expect(stalledRun).toMatchObject({ nodes: { writer: "stalled" } });
    expect(stalledRun?.status).not.toBe("timed_out");
    expect(stalledRun?.status).not.toBe("aborted");
    expect(stalledRun?.status).not.toBe("failed");
    expect(stalledRun?.events).toContainEqual({
      at: "2026-06-17T12:00:50.000Z",
      nodeId: "writer",
      status: "stalled",
      type: "node.status",
    });

    const terminalEvents = readRunControlEvents(workspaceRoot, runId).filter(
      (event) =>
        event.type === "run.status" &&
        ["aborted", "failed", "timed_out"].includes(String(event.status))
    );
    expect(terminalEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    await supervisor.flush();
    expect(await readRun({ runId, workspaceRoot })).toMatchObject({
      nodes: { writer: "stalled" },
    });
    await supervisor.stop();
  });

  it("stores named default and overrideable heartbeat/stale thresholds in the manifest", async () => {
    const contracts = await loadContracts();
    const defaultHeartbeatIntervalMs = positiveNamedDefault(
      contracts.DEFAULT_RUN_CONTROL_HEARTBEAT_INTERVAL_MS
    );
    const defaultNodeStaleAfterMs = positiveNamedDefault(
      contracts.DEFAULT_RUN_CONTROL_NODE_STALE_AFTER_MS
    );
    expect(defaultNodeStaleAfterMs).toBeGreaterThan(defaultHeartbeatIntervalMs);
    expect(
      contracts.safeParseMokaRunEvent?.({
        at: "2026-06-17T12:00:05.000Z",
        heartbeatIntervalMs: defaultHeartbeatIntervalMs,
        type: "run.heartbeat",
      }).success
    ).toBe(true);

    const baseManifest = {
      effort: "quick",
      events: [],
      mode: "write",
      nodes: { writer: "queued" },
      runId: "run-contract-thresholds",
      staleDetection: {
        heartbeatIntervalMs: defaultHeartbeatIntervalMs,
        nodeStaleAfterMs: defaultNodeStaleAfterMs,
      },
      status: "queued",
      target: "local",
    };
    expect(contracts.safeParseMokaRunManifest?.(baseManifest).success).toBe(
      true
    );

    await createRun({
      effort: "normal",
      mode: "write",
      nodeIds: ["writer"],
      runId: "run-default-thresholds",
      target: "local",
      workspaceRoot,
    });
    expect(
      readJson(
        runPath(workspaceRoot, "run-default-thresholds", "manifest.json")
      )
    ).toMatchObject({
      staleDetection: {
        heartbeatIntervalMs: defaultHeartbeatIntervalMs,
        nodeStaleAfterMs: defaultNodeStaleAfterMs,
      },
    });

    await createRun({
      effort: "normal",
      mode: "write",
      nodeIds: ["writer"],
      runId: "run-overridden-thresholds",
      staleDetection: {
        heartbeatIntervalMs: 1234,
        nodeStaleAfterMs: 5678,
      },
      target: "local",
      workspaceRoot,
    } as Parameters<typeof createRun>[0]);
    expect(
      readJson(
        runPath(workspaceRoot, "run-overridden-thresholds", "manifest.json")
      )
    ).toMatchObject({
      staleDetection: {
        heartbeatIntervalMs: 1234,
        nodeStaleAfterMs: 5678,
      },
    });
  });
});
