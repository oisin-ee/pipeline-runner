import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runRunnerFinalize } from "../src/runner-command/finalize";
import {
  captureEventBatches,
  cleanupRunnerCommandFixtures,
  commandHookResult,
  eventTypes,
  finalResults,
  hookResultEvents,
  writeLifecycleConfig,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../src/run-state/git-refs", () => ({
  prepareRunnerGitWorkspace: vi.fn(
    (_payload, options?: { cwd?: string }) => options?.cwd ?? "/workspace"
  ),
  promoteFinalRef: vi.fn(() => "final-sha"),
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
  cleanupRunnerCommandFixtures();
});

describe("runner-finalize lifecycle hooks", () => {
  it("runs workflow.success before workflow.complete and records a passing final result", async () => {
    const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
    writeLifecycleConfig(dir, [
      "workflow.success",
      "workflow.failure",
      "workflow.complete",
    ]);
    const batches: unknown[][] = [];
    mockExeca.mockImplementation(commandHookResult());

    const exitCode = await runRunnerFinalize({
      argoStatus: "Succeeded",
      cwd: dir,
      fetch: captureEventBatches(batches),
      payloadFile: payloadPath,
      scheduleFile: schedulePath,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(eventTypes(batches)).toEqual([
      "hook.start",
      "hook.finish",
      "hook.result",
      "hook.start",
      "hook.finish",
      "hook.result",
      "workflow.finish",
    ]);
    expect(
      hookResultEvents(batches).map((event) => event.hookResult?.event)
    ).toEqual(["workflow.success", "workflow.complete"]);
    expect(finalResults(batches)).toEqual([
      { outcome: "PASS", workflowId: "schedule-run-1-root" },
    ]);
  });

  it.each(["Failed", "Error"])(
    "runs workflow.failure before workflow.complete and records a failing final result for %s",
    async (argoStatus) => {
      const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
      writeLifecycleConfig(dir, [
        "workflow.success",
        "workflow.failure",
        "workflow.complete",
      ]);
      const batches: unknown[][] = [];
      mockExeca.mockImplementation(commandHookResult());

      const exitCode = await runRunnerFinalize({
        argoStatus,
        cwd: dir,
        fetch: captureEventBatches(batches),
        payloadFile: payloadPath,
        scheduleFile: schedulePath,
        stderr: { write: () => true },
      });

      expect(exitCode).toBe(1);
      expect(
        hookResultEvents(batches).map((event) => event.hookResult?.event)
      ).toEqual(["workflow.failure", "workflow.complete"]);
      expect(finalResults(batches)).toEqual([
        { outcome: "FAIL", workflowId: "schedule-run-1-root" },
      ]);
    }
  );

  it.each([
    "Stopped with strategy 'Stop'",
    "workflow shutdown with strategy:  Stop",
  ])(
    "records cancellation when Argo reports shutdown Stop failure message %s",
    async (message) => {
      const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
      writeLifecycleConfig(dir, [
        "workflow.success",
        "workflow.failure",
        "workflow.complete",
      ]);
      const batches: unknown[][] = [];
      mockExeca.mockImplementation(commandHookResult());

      const exitCode = await runRunnerFinalize({
        argoFailures: JSON.stringify([
          {
            displayName: "node-one",
            message,
            phase: "Failed",
            templateName: "task-one",
          },
        ]),
        argoStatus: "Failed",
        cwd: dir,
        fetch: captureEventBatches(batches),
        payloadFile: payloadPath,
        scheduleFile: schedulePath,
        stderr: { write: () => true },
      });

      expect(exitCode).toBe(1);
      expect(eventTypes(batches)).toEqual(["run.cancelled", "workflow.finish"]);
      expect(finalResults(batches)).toEqual([
        { outcome: "CANCELLED", workflowId: "schedule-run-1-root" },
      ]);
    }
  );

  it("turns a workflow.success hook failure into a failed final result before workflow.complete runs", async () => {
    const { dir, payloadPath, schedulePath } = writeRunnerCommandFixture();
    writeLifecycleConfig(dir, [
      "workflow.success",
      "workflow.failure",
      "workflow.complete",
    ]);
    const batches: unknown[][] = [];
    mockExeca.mockImplementation(
      commandHookResult({ failEvent: "workflow.success" })
    );

    const exitCode = await runRunnerFinalize({
      argoStatus: "Succeeded",
      cwd: dir,
      fetch: captureEventBatches(batches),
      payloadFile: payloadPath,
      scheduleFile: schedulePath,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(1);
    expect(
      hookResultEvents(batches).map((event) => event.hookResult?.event)
    ).toEqual(["workflow.success", "workflow.complete"]);
    expect(finalResults(batches)).toEqual([
      { outcome: "FAIL", workflowId: "schedule-run-1-root" },
    ]);
  });
});
