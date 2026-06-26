import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MokaRunController,
  MokaRunEvent,
} from "../src/run-control/contracts";
import {
  type CreateRunRequest,
  fileRunControlStore,
  type RunControlStore,
} from "../src/run-control/run-control-store";

function relativeToWorkspace(workspaceRoot: string, path: string): string {
  const absolutePath = isAbsolute(path) ? path : join(workspaceRoot, path);
  return relative(workspaceRoot, absolutePath).split(sep).join("/");
}

describe("RunControlStore filesystem seam", () => {
  let workspaceRoot: string;
  let store: RunControlStore;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "pipeline-run-store-seam-"));
    store = fileRunControlStore(workspaceRoot);
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("reconstructs the manifest by replaying recorded events through the seam", async () => {
    const create: CreateRunRequest = {
      effort: "thorough",
      mode: "write",
      nodeIds: ["planner", "writer"],
      runId: "run-seam",
      target: "remote",
    };
    await Effect.runPromise(store.createRun(create));

    const events: MokaRunEvent[] = [
      { at: "2026-06-26T10:00:00.000Z", status: "running", type: "run.status" },
      {
        at: "2026-06-26T10:00:01.000Z",
        nodeId: "planner",
        status: "passed",
        type: "node.status",
      },
      {
        at: "2026-06-26T10:00:02.000Z",
        nodeId: "writer",
        status: "failed",
        type: "node.status",
      },
      { at: "2026-06-26T10:00:03.000Z", status: "failed", type: "run.status" },
    ];

    for (const event of events) {
      await Effect.runPromise(store.recordEvent({ event, runId: "run-seam" }));
    }

    // A fresh store instance proves replay reads from the on-disk event log,
    // not in-memory state.
    const reopened = fileRunControlStore(workspaceRoot);
    const replayed = await Effect.runPromise(
      reopened.readRun({ runId: "run-seam" })
    );

    expect(replayed).toMatchObject({
      effort: "thorough",
      mode: "write",
      nodes: { planner: "passed", writer: "failed" },
      runId: "run-seam",
      status: "failed",
      target: "remote",
    });
    expect(replayed?.events).toEqual(events);
  });

  it("supports the convenience status writers and node sessions", async () => {
    await Effect.runPromise(
      store.createRun({
        effort: "quick",
        mode: "read-only",
        nodeIds: ["writer"],
        runId: "run-status",
        target: "local",
      })
    );

    await Effect.runPromise(
      store.updateRunStatus({
        at: "2026-06-26T11:00:00.000Z",
        runId: "run-status",
        status: "running",
      })
    );
    await Effect.runPromise(
      store.updateNodeStatus({
        at: "2026-06-26T11:00:01.000Z",
        nodeId: "writer",
        runId: "run-status",
        status: "passed",
      })
    );
    await Effect.runPromise(
      store.updateNodeSession({
        nodeId: "writer",
        runId: "run-status",
        sessionId: "session-123",
      })
    );

    const run = await Effect.runPromise(store.readRun({ runId: "run-status" }));
    expect(run).toMatchObject({
      nodes: { writer: "passed" },
      status: "running",
    });

    const paths = store.statusPaths({ runId: "run-status" });
    expect(paths).toEqual({
      events: ".pipeline/runs/run-status/events.jsonl",
      manifest: ".pipeline/runs/run-status/manifest.json",
      status: ".pipeline/runs/run-status/status.json",
    });
    const statusFile: unknown = JSON.parse(
      readFileSync(join(workspaceRoot, paths.status), "utf8")
    );
    expect(statusFile).toMatchObject({
      nodes: { writer: { sessionId: "session-123" } },
    });
  });

  it("persists the controller and node artifacts, and lists runs deterministically", async () => {
    await Effect.runPromise(
      store.createRun({
        effort: "normal",
        mode: "write",
        nodeIds: ["writer"],
        runId: "run-b",
        target: "local",
      })
    );
    await Effect.runPromise(
      store.createRun({
        effort: "normal",
        mode: "write",
        nodeIds: ["writer"],
        runId: "run-a",
        target: "local",
      })
    );

    const controller: MokaRunController = {
      argv: ["moka", "run"],
      cwd: workspaceRoot,
      paths: store.statusPaths({ runId: "run-a" }),
      pid: 4242,
      startedAt: "2026-06-26T12:00:00.000Z",
    };
    const withController = await Effect.runPromise(
      store.updateRunController({ controller, runId: "run-a" })
    );
    expect(withController.controller).toEqual(controller);

    const artifact = await Effect.runPromise(
      store.writeNodeArtifact({
        content: '{"result":"ok"}\n',
        name: "summary.json",
        nodeId: "writer",
        runId: "run-a",
      })
    );
    expect(relativeToWorkspace(workspaceRoot, artifact.path)).toBe(
      ".pipeline/runs/run-a/nodes/writer/summary.json"
    );
    expect(readFileSync(join(workspaceRoot, artifact.path), "utf8")).toBe(
      '{"result":"ok"}\n'
    );

    const runs = await Effect.runPromise(store.listRuns());
    expect(runs.map((run) => run.runId)).toEqual(["run-a", "run-b"]);
  });
});
