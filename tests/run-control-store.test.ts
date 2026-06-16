import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MokaNodeStatus,
  MokaRunEvent,
  MokaRunManifest,
  MokaRunStatus,
  RunEffort,
  RunMode,
  RunTarget,
} from "../src/run-control/contracts";

type Awaitable<T> = Promise<T> | T;

interface StoreContext {
  workspaceRoot: string;
}

interface RunControlStoreModule {
  createRun: (
    input: StoreContext & {
      effort: RunEffort;
      mode: RunMode;
      nodeIds: string[];
      runId: string;
      target: RunTarget;
    }
  ) => Awaitable<MokaRunManifest>;
  listRuns: (input: StoreContext) => Awaitable<MokaRunManifest[]>;
  readRun: (
    input: StoreContext & { runId: string }
  ) => Awaitable<MokaRunManifest | undefined>;
  recordEvent: (
    input: StoreContext & { event: MokaRunEvent; runId: string }
  ) => Awaitable<void>;
  updateNodeStatus: (
    input: StoreContext & {
      at: string;
      nodeId: string;
      runId: string;
      status: MokaNodeStatus;
    }
  ) => Awaitable<void>;
  updateRunStatus: (
    input: StoreContext & {
      at: string;
      runId: string;
      status: MokaRunStatus;
    }
  ) => Awaitable<void>;
  writeNodeArtifact: (
    input: StoreContext & {
      content: string;
      contentType?: string;
      name: string;
      nodeId: string;
      runId: string;
    }
  ) => Awaitable<{ path: string }>;
}

const RUN_STORE_MODULE_PATH = "../src/run-control/store";
const WRITER_NODE_ARTIFACT_PATH =
  /^\.pipeline\/runs\/run-layout\/nodes\/writer\//;

async function loadRunStore(): Promise<RunControlStoreModule> {
  return (await import(RUN_STORE_MODULE_PATH)) as RunControlStoreModule;
}

function runPath(workspaceRoot: string, runId: string, ...parts: string[]) {
  return join(workspaceRoot, ".pipeline", "runs", runId, ...parts);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeRelativePath(workspaceRoot: string, path: string): string {
  const absolutePath = isAbsolute(path) ? path : join(workspaceRoot, path);
  return relative(workspaceRoot, absolutePath).split(sep).join("/");
}

describe("file-backed run-control store", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "pipeline-run-store-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("creates the run file layout and writes node artifacts from logical identifiers", async () => {
    const store = await loadRunStore();
    const runId = "run-layout";

    await store.createRun({
      effort: "quick",
      mode: "write",
      nodeIds: ["planner", "writer"],
      runId,
      target: "local",
      workspaceRoot,
    });

    const manifestPath = runPath(workspaceRoot, runId, "manifest.json");
    const statusPath = runPath(workspaceRoot, runId, "status.json");
    const eventsPath = runPath(workspaceRoot, runId, "events.jsonl");
    const plannerNodeDir = runPath(workspaceRoot, runId, "nodes", "planner");
    const writerNodeDir = runPath(workspaceRoot, runId, "nodes", "writer");

    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(statusPath)).toBe(true);
    expect(existsSync(eventsPath)).toBe(true);
    expect(statSync(plannerNodeDir).isDirectory()).toBe(true);
    expect(statSync(writerNodeDir).isDirectory()).toBe(true);

    const manifest = readJson(manifestPath) as MokaRunManifest;
    expect(manifest).toMatchObject({
      effort: "quick",
      mode: "write",
      nodes: {
        planner: "queued",
        writer: "queued",
      },
      runId,
      status: "queued",
      target: "local",
    });
    expect(Array.isArray(manifest.events)).toBe(true);
    expect(readJson(statusPath)).toMatchObject({
      nodes: {
        planner: "queued",
        writer: "queued",
      },
      status: "queued",
    });

    const artifact = await store.writeNodeArtifact({
      content: '{"result":"ok"}\n',
      contentType: "application/json",
      name: "summary.json",
      nodeId: "writer",
      runId,
      workspaceRoot,
    });

    const artifactRelativePath = normalizeRelativePath(
      workspaceRoot,
      artifact.path
    );
    expect(artifactRelativePath).toMatch(WRITER_NODE_ARTIFACT_PATH);
    expect(
      readFileSync(join(workspaceRoot, artifactRelativePath), "utf8")
    ).toBe('{"result":"ok"}\n');
  });

  it("appends recorded events as JSONL in the order they are received", async () => {
    const store = await loadRunStore();
    const runId = "run-events";
    await store.createRun({
      effort: "normal",
      mode: "read-only",
      nodeIds: ["writer"],
      runId,
      target: "remote",
      workspaceRoot,
    });

    const first: MokaRunEvent = {
      at: "2026-06-17T10:00:00.000Z",
      status: "running",
      type: "run.status",
    };
    const second: MokaRunEvent = {
      at: "2026-06-17T10:00:01.000Z",
      nodeId: "writer",
      status: "running",
      type: "node.status",
    };
    const third: MokaRunEvent = {
      at: "2026-06-17T10:00:02.000Z",
      nodeId: "writer",
      status: "passed",
      type: "node.status",
    };

    const beforeRecordedEvents = readFileSync(
      runPath(workspaceRoot, runId, "events.jsonl"),
      "utf8"
    );
    await store.recordEvent({ event: first, runId, workspaceRoot });
    await store.recordEvent({ event: second, runId, workspaceRoot });
    const beforeThirdAppend = readFileSync(
      runPath(workspaceRoot, runId, "events.jsonl"),
      "utf8"
    );
    await store.recordEvent({ event: third, runId, workspaceRoot });

    const eventsPath = runPath(workspaceRoot, runId, "events.jsonl");
    const eventLog = readFileSync(eventsPath, "utf8");

    expect(eventLog.startsWith(beforeThirdAppend)).toBe(true);
    expect(eventLog.endsWith("\n")).toBe(true);
    expect(
      eventLog
        .slice(beforeRecordedEvents.length)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    ).toEqual([first, second, third]);
  });

  it("reads rebuilt run state and deterministic run lists after a fresh module load", async () => {
    const store = await loadRunStore();

    await store.createRun({
      effort: "quick",
      mode: "read-only",
      nodeIds: ["reader"],
      runId: "run-b",
      target: "local",
      workspaceRoot,
    });
    await store.createRun({
      effort: "thorough",
      mode: "write",
      nodeIds: ["planner", "writer"],
      runId: "run-a",
      target: "remote",
      workspaceRoot,
    });

    const events: MokaRunEvent[] = [
      {
        at: "2026-06-17T11:00:00.000Z",
        status: "running",
        type: "run.status",
      },
      {
        at: "2026-06-17T11:00:01.000Z",
        nodeId: "planner",
        status: "running",
        type: "node.status",
      },
      {
        at: "2026-06-17T11:00:02.000Z",
        nodeId: "planner",
        status: "passed",
        type: "node.status",
      },
      {
        at: "2026-06-17T11:00:03.000Z",
        nodeId: "writer",
        status: "failed",
        type: "node.status",
      },
      {
        at: "2026-06-17T11:00:04.000Z",
        status: "failed",
        type: "run.status",
      },
    ];

    await store.updateRunStatus({
      at: events[0].at,
      runId: "run-a",
      status: events[0].status as MokaRunStatus,
      workspaceRoot,
    });
    await store.updateNodeStatus({
      at: events[1].at,
      nodeId: "planner",
      runId: "run-a",
      status: events[1].status as MokaNodeStatus,
      workspaceRoot,
    });
    await store.updateNodeStatus({
      at: events[2].at,
      nodeId: "planner",
      runId: "run-a",
      status: events[2].status as MokaNodeStatus,
      workspaceRoot,
    });
    await store.updateNodeStatus({
      at: events[3].at,
      nodeId: "writer",
      runId: "run-a",
      status: events[3].status as MokaNodeStatus,
      workspaceRoot,
    });
    await store.updateRunStatus({
      at: events[4].at,
      runId: "run-a",
      status: events[4].status as MokaRunStatus,
      workspaceRoot,
    });

    vi.resetModules();
    const restartedStore = await loadRunStore();

    const restartedRun = await restartedStore.readRun({
      runId: "run-a",
      workspaceRoot,
    });
    expect(restartedRun).toMatchObject({
      effort: "thorough",
      mode: "write",
      nodes: {
        planner: "passed",
        writer: "failed",
      },
      runId: "run-a",
      status: "failed",
      target: "remote",
    });
    expect(restartedRun?.events.slice(-events.length)).toEqual(events);

    const listedRuns = await restartedStore.listRuns({ workspaceRoot });
    expect(listedRuns.map((run) => run.runId)).toEqual(["run-a", "run-b"]);
    expect(listedRuns[0]).toMatchObject({
      effort: "thorough",
      mode: "write",
      nodes: {
        planner: "passed",
        writer: "failed",
      },
      runId: "run-a",
      status: "failed",
      target: "remote",
    });
    expect(listedRuns[0]?.events.slice(-events.length)).toEqual(events);
    expect(listedRuns[1]).toMatchObject({
      effort: "quick",
      mode: "read-only",
      nodes: {
        reader: "queued",
      },
      runId: "run-b",
      status: "queued",
      target: "local",
    });
  });
});
