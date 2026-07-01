import { readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileRunControlStore } from "../src/run-control/run-control-store";
import { runPreSchedulePhase } from "../src/runner-command/pre-schedule";
import { parseRunnerCommandPayload } from "../src/runner-command-contract";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import {
  cleanupRunnerCommandFixtures,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

vi.mock("../src/run-state/git-refs", () => ({
  prepareRunnerGitWorkspace: vi.fn(
    async (_payload, options?: { cwd?: string }) => options?.cwd ?? "/workspace"
  ),
}));

vi.mock("../src/runner/subprocess", () => ({
  runLaunchPlan: vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ ac: [], findings: [] }),
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
  cleanupRunnerCommandFixtures();
});

describe("runner-pre-schedule", () => {
  it("creates the dynamic run record before recording pre-research status", async () => {
    const runId = "run-pre-schedule-seed";
    const fixture = writeRunnerCommandFixture({
      runId,
      tempPrefix: "runner-pre-schedule-",
    });
    const payload = parseRunnerCommandPayload(
      readFileSync(fixture.payloadPath, "utf8")
    );
    writeFileSync(
      fixture.payloadPath,
      JSON.stringify({
        ...payload,
        submission: { kind: "graph", mode: "quick" },
      })
    );

    const runControlStore = fileRunControlStore(fixture.dir);
    const durableStore = inMemoryDurableRunStore();
    const exitCode = await runPreSchedulePhase({
      cwd: fixture.dir,
      payloadFile: fixture.payloadPath,
      phase: "pre-research",
      resolvePersistence: () =>
        Effect.succeed({ durableStore, runControlStore }),
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    const run = await Effect.runPromise(runControlStore.readRun({ runId }));
    expect(run?.nodes).toMatchObject({
      "pre-generate-schedule": "queued",
      "pre-planning": "queued",
      "pre-research": "passed",
    });
    expect(durableStore.get(runId, "pre-research")?.result.status).toBe(
      "passed"
    );
  });
});
