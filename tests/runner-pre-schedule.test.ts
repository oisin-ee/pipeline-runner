import { readFileSync, writeFileSync } from "node:fs";

import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fileRunControlStore } from "../src/run-control/run-control-store";
import type { RunnerLaunchPlan } from "../src/runner";
import { parseRunnerCommandPayload } from "../src/runner-command-contract";
import { runPreSchedulePhase } from "../src/runner-command/pre-schedule";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import {
  cleanupRunnerCommandFixtures,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

vi.mock("../src/run-state/git-refs", () => ({
  prepareRunnerGitWorkspace: vi.fn(
    (_payload, options?: { cwd?: string }) => options?.cwd ?? "/workspace"
  ),
}));

vi.mock("../src/runner/subprocess", () => ({
  runLaunchPlan: vi.fn(() => ({
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
      readFileSync(fixture.payloadPath, "utf-8")
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
    expect(
      Option.getOrThrow(durableStore.get(runId, "pre-research")).result.status
    ).toBe("passed");
  });

  it("embeds a bounded remote phase contract and canonicalizes JSON output", async () => {
    const runId = "run-pre-schedule-contract";
    const fixture = writeRunnerCommandFixture({
      runId,
      tempPrefix: "runner-pre-schedule-",
    });
    const payload = parseRunnerCommandPayload(
      readFileSync(fixture.payloadPath, "utf-8")
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
    let launchPlan = Option.none<RunnerLaunchPlan>();
    const exitCode = await runPreSchedulePhase({
      cwd: fixture.dir,
      executor: (plan) => {
        launchPlan = Option.some(plan);
        return {
          exitCode: 0,
          stdout: [
            "research summary",
            "```json",
            JSON.stringify({ ac: [], findings: [] }),
            "```",
          ].join("\n"),
        };
      },
      payloadFile: fixture.payloadPath,
      phase: "pre-research",
      resolvePersistence: () =>
        Effect.succeed({ durableStore, runControlStore }),
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(Option.getOrThrow(launchPlan).args.join("\n")).toContain(
      "Automated remote pre-schedule research phase."
    );
    expect(Option.getOrThrow(launchPlan).args.join("\n")).toContain(
      "Do not spawn subagents or delegate to task tools."
    );
    expect(
      Option.getOrThrow(durableStore.get(runId, "pre-research")).result.output
    ).toBe(JSON.stringify({ ac: [], findings: [] }));
  });
});
