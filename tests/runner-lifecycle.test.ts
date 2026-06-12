import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../src/run-state/git-refs", () => ({
  prepareRunnerGitWorkspace: vi.fn(
    async (_payload, options?: { cwd?: string }) => options?.cwd ?? "/workspace"
  ),
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
  cleanupRunnerCommandFixtures();
});

describe("runner-lifecycle workflow.start", () => {
  it("uses the shared lifecycle start phase and records planned/start before the hook", async () => {
    const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
    writeLifecycleConfig(dir, ["workflow.start"]);
    const batches: unknown[][] = [];
    mockExeca.mockImplementation(commandHookResult());

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
    mockExeca.mockImplementation(
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
});
