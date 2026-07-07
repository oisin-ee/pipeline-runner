import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateRunRequest } from "../src/run-control/run-control-store";
import { fileRunControlStore } from "../src/run-control/run-control-store";
import { runRunnerLifecycle } from "../src/runner-command/lifecycle";
import {
  captureEventBatches,
  cleanupRunnerCommandFixtures,
  commandHookResult,
  eventTypes,
  hookResultEvents,
  writeLifecycleConfig,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

// vi.hoisted gives us a loosely-typed vi.fn() (no execa signature constraint),
// which lets commandHookResult() implementations satisfy mockImplementation
// without requiring a type-escape cast.
const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: execaMock,
}));

vi.mock("../src/run-state/git-refs", () => ({
  prepareRunnerGitWorkspace: vi.fn(
    (_payload: unknown, options?: { cwd?: string }) =>
      options?.cwd ?? "/workspace"
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
  cleanupRunnerCommandFixtures();
});

describe("runner-lifecycle workflow.start", () => {
  it("uses the shared lifecycle start phase and records planned/start before the hook", async () => {
    const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
    writeLifecycleConfig(dir, ["workflow.start"]);
    const batches: unknown[][] = [];
    execaMock.mockImplementation(commandHookResult());

    const exitCode = await runRunnerLifecycle({
      cwd: dir,
      fetch: captureEventBatches(batches),
      payloadFile: payloadPath,
      phase: "workflow.start",
      scheduleFile: schedulePath,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(eventTypes(batches)).toEqual([
      "workflow.planned",
      "workflow.start",
      "hook.start",
      "hook.finish",
      "hook.result",
    ]);
    expect(
      hookResultEvents(batches).map((event) => event.hookResult?.event)
    ).toEqual(["workflow.start"]);
  });

  it("returns a failing exit code when the workflow.start hook fails", async () => {
    const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
    writeLifecycleConfig(dir, ["workflow.start"]);
    const batches: unknown[][] = [];
    execaMock.mockImplementation(
      commandHookResult({ failEvent: "workflow.start" })
    );

    const exitCode = await runRunnerLifecycle({
      cwd: dir,
      fetch: captureEventBatches(batches),
      payloadFile: payloadPath,
      phase: "workflow.start",
      scheduleFile: schedulePath,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(1);
    expect(
      hookResultEvents(batches).map((event) => event.hookResult?.status)
    ).toEqual(["fail"]);
  });

  describe("PIPE-94.5: createRun upsert on workflow.start", () => {
    // AC1: when db.url is configured the lifecycle builds a COMPLETE request and
    // persists a manifest whose node map carries the real schedule node ids.
    it("AC1: persists a manifest with the real schedule nodeIds when db.url is configured", async () => {
      const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture({
        runId: "run-pipe945",
      });
      writeLifecycleConfig(dir, ["workflow.start"]);
      execaMock.mockImplementation(commandHookResult());
      const store = fileRunControlStore(join(dir, "store"));
      const captured: CreateRunRequest[] = [];

      const exitCode = await runRunnerLifecycle({
        cwd: dir,
        fetch: captureEventBatches([]),
        payloadFile: payloadPath,
        phase: "workflow.start",
        scheduleFile: schedulePath,
        stderr: { write: () => true },
        upsertRunRecord: async (request) => {
          captured.push(request);
          await Effect.runPromise(store.createRun(request));
        },
      });

      expect(exitCode).toBe(0);
      expect(captured).toHaveLength(1);
      const [request] = captured;
      expect(request.runId).toBe("run-pipe945");
      // The complete request carries the real, non-empty node list (not []).
      expect(request.nodeIds).toEqual(["command"]);
      // The raw schedule is persisted so `moka resume` can rebuild the graph.
      expect(request.schedule).toContain("schedule_id: run-pipe945");
      // The persisted manifest's node map is built FROM nodeIds — real nodes.
      const manifest = await Effect.runPromise(
        store.readRun({ runId: "run-pipe945" })
      );
      expect(Object.keys(manifest?.nodes ?? {})).toEqual(["command"]);
    });

    // AC2: order-independent idempotency — submit (db-reachable) writes FIRST,
    // then the lifecycle writes SECOND. Because both writers go through the
    // shared builder (real nodeIds), the first-writer-wins upsert leaves ONE
    // manifest with real nodes regardless of order (the PIPE-94.5 bug fix).
    it("AC2: submit writes first, lifecycle second → one manifest with real nodes (lossless)", async () => {
      const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture({
        runId: "run-idempotent",
      });
      writeLifecycleConfig(dir, ["workflow.start"]);
      execaMock.mockImplementation(commandHookResult());
      const store = fileRunControlStore(join(dir, "store"));

      // Submit-side createRun FIRST, with the complete node list the shared
      // builder now produces (real nodeIds, never []).
      await Effect.runPromise(
        store.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["command"],
          runId: "run-idempotent",
          schedule: "schedule_id: run-idempotent",
          target: "remote",
        })
      );

      const captured: CreateRunRequest[] = [];
      const exitCode = await runRunnerLifecycle({
        cwd: dir,
        fetch: captureEventBatches([]),
        payloadFile: payloadPath,
        phase: "workflow.start",
        scheduleFile: schedulePath,
        stderr: { write: () => true },
        upsertRunRecord: async (request) => {
          captured.push(request);
          // First-writer-wins: the second createRun must not throw.
          await Effect.runPromise(store.createRun(request));
        },
      });

      expect(exitCode).toBe(0);
      // The lifecycle's request also carries real nodeIds (no nodeIds: []).
      expect(captured[0].nodeIds).toEqual(["command"]);
      // Exactly one manifest survives, with the real node list intact.
      const runs = await Effect.runPromise(store.listRuns());
      expect(runs).toHaveLength(1);
      const manifest = await Effect.runPromise(
        store.readRun({ runId: "run-idempotent" })
      );
      expect(Object.keys(manifest?.nodes ?? {})).toEqual(["command"]);
    });

    // AC3: when db.url is absent (no override, real guard path) the lifecycle
    // must still emit events and exit 0; createRun is skipped and logged.
    it("AC3: db.url absent → lifecycle exits 0, emits events, createRun skipped and logged", async () => {
      const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
      writeLifecycleConfig(dir, ["workflow.start"]);
      execaMock.mockImplementation(commandHookResult());
      const stderrLines: string[] = [];

      // Remove MOKA_DB_URL so loadMokaDbUrl() returns undefined.  The config
      // file is absent in the temp dir too, so the guard fires the skip branch.
      const savedMokaDbUrl = process.env.MOKA_DB_URL;
      delete process.env.MOKA_DB_URL;

      let exitCode = -1;
      try {
        exitCode = await runRunnerLifecycle({
          cwd: dir,
          fetch: captureEventBatches([]),
          payloadFile: payloadPath,
          phase: "workflow.start",
          scheduleFile: schedulePath,
          // No upsertRunRecord — exercises the real default guard path.
          stderr: {
            write: (chunk: string | Uint8Array) => {
              stderrLines.push(
                typeof chunk === "string" ? chunk : chunk.toString()
              );
              return true;
            },
          },
        });
      } finally {
        // Restore env regardless of outcome.
        if (savedMokaDbUrl !== undefined) {
          process.env.MOKA_DB_URL = savedMokaDbUrl;
        }
      }

      expect(exitCode).toBe(0);
      const stderr = stderrLines.join("");
      expect(stderr).toContain("db.url not configured");
      expect(stderr).toContain("skipping createRun");
    });
  });
});
