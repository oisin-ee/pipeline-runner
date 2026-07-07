import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runRunnerCommand } from "../src/runner-command/run";
import { createRunnerEventSink } from "../src/runner-event-sink";
import {
  flushAndReport,
  RunnerCommandIoServiceLive,
} from "../src/runtime/services/runner-command-io-service";
import {
  captureEventBatches,
  cleanupRunnerCommandFixtures,
  finalResults,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

const RESOLVED_VALUE = undefined;

interface RunnerCommandPolicyMocks {
  commitAndPushNodeRef: ReturnType<typeof vi.fn>;
  mergeDependencyRefs: ReturnType<typeof vi.fn>;
  prepareRunnerGitWorkspace: ReturnType<typeof vi.fn>;
  runScheduledWorkflowTask: ReturnType<typeof vi.fn>;
}

const mockState = (): RunnerCommandPolicyMocks =>
  (
    globalThis as typeof globalThis & {
      __runnerCommandPolicyMocks: RunnerCommandPolicyMocks;
    }
  ).__runnerCommandPolicyMocks;

const installMockState = (): RunnerCommandPolicyMocks => {
  const state = {
    commitAndPushNodeRef: vi.fn(),
    mergeDependencyRefs: vi.fn(),
    prepareRunnerGitWorkspace: vi.fn(),
    runScheduledWorkflowTask: vi.fn(),
  };
  (
    globalThis as typeof globalThis & {
      __runnerCommandPolicyMocks: RunnerCommandPolicyMocks;
    }
  ).__runnerCommandPolicyMocks = state;
  return state;
};

vi.mock("../src/pipeline-runtime", () => ({
  runScheduledWorkflowTask: (...args: unknown[]) =>
    mockState().runScheduledWorkflowTask(...args),
}));

vi.mock("execa", () => ({
  execa: vi.fn(() => ({ exitCode: 0 })),
}));

// The runner authenticates through the central broker; credential prep writes
// broker config to $HOME. These tests cover hook policy + logging, not
// credential materialization, so stub it to a no-op (broker config is proven in
// credentials/runner.test.ts).
vi.mock("../src/credentials/runner", () => ({
  prepareOpencodeCredentials: () => ({ brokerConfigured: [] }),
}));

vi.mock("../src/run-state/git-refs", () => ({
  commitAndPushNodeRef: (...args: unknown[]) =>
    mockState().commitAndPushNodeRef(...args),
  mergeDependencyRefs: (...args: unknown[]) =>
    mockState().mergeDependencyRefs(...args),
  prepareRunnerGitWorkspace: (...args: unknown[]) =>
    mockState().prepareRunnerGitWorkspace(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (
    globalThis as typeof globalThis & {
      __runnerCommandPolicyMocks?: RunnerCommandPolicyMocks;
    }
  ).__runnerCommandPolicyMocks = undefined;
  cleanupRunnerCommandFixtures();
});

const captureOutput = (): {
  stream: { write: (chunk: string | Uint8Array) => boolean };
  text: () => string;
} => {
  let value = "";
  return {
    stream: {
      write: (chunk) => {
        value +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf-8");
        return true;
      },
    },
    text: () => value,
  };
};

const logRecords = (content: string): Record<string, unknown>[] =>
  content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const logPhases = (content: string): string[] =>
  logRecords(content)
    .filter(
      (record): record is { phase: string; status: string } =>
        typeof record.phase === "string" && typeof record.status === "string"
    )
    .map((record) => `${record.phase}:${record.status}`);

describe("runner-command hook policy", () => {
  it("retries terminal event flush before reporting failure", async () => {
    vi.useFakeTimers();
    const batches: unknown[][] = [];
    let attempts = 0;
    const capture = captureEventBatches(batches);
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        attempts += 1;
        if (attempts <= 2) {
          return new Response("console unavailable", {
            status: 503,
          });
        }
        return await capture(input, init);
      }
    );
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch,
      runId: "run-terminal-flush",
      url: "https://pipeline-console.example/api/pipeline/runner-events",
    });
    const stderr = captureOutput();

    sink.recordFinalResult("PASS", "default");
    const flush = Effect.runPromise(
      Effect.provide(
        flushAndReport(sink, stderr.stream),
        RunnerCommandIoServiceLive
      )
    );
    await vi.advanceTimersByTimeAsync(2000);
    await flush;

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(finalResults(batches)).toEqual([
      { outcome: "PASS", workflowId: "default" },
    ]);
    expect(stderr.text()).toBe("");
  });

  it("passes payload hook policy into scheduled task execution", async () => {
    const fixture = writeRunnerCommandFixture({
      hookPolicy: { allowCommandHooks: false },
      runId: "run-policy",
      tempPrefix: "runner-command-policy-",
    });
    const mocks = installMockState();
    mocks.runScheduledWorkflowTask.mockResolvedValue({
      evidence: [],
      exitCode: 0,
      output: "ok",
      status: "passed",
    });
    mocks.prepareRunnerGitWorkspace.mockResolvedValue(fixture.dir);
    mocks.mergeDependencyRefs.mockResolvedValue(RESOLVED_VALUE);
    mocks.commitAndPushNodeRef.mockResolvedValue(RESOLVED_VALUE);
    const fetch = vi.fn(
      async () => await Promise.resolve(new Response(null, { status: 202 }))
    );
    const stdout = captureOutput();
    const stderr = captureOutput();

    const exitCode = await runRunnerCommand({
      cwd: fixture.dir,
      fetch,
      payloadFile: fixture.payloadPath,
      scheduleFile: fixture.schedulePath,
      stderr: stderr.stream,
      stdout: stdout.stream,
      taskDescriptorFile: fixture.descriptorPath,
    });

    expect(exitCode).toBe(0);
    expect(mocks.runScheduledWorkflowTask).toHaveBeenCalledWith(
      expect.objectContaining({
        hookPolicy: { allowCommandHooks: false },
        nodeId: "command",
        workflowId: "schedule-run-policy-root",
      })
    );
  });

  it("writes runner lifecycle progress to stdout without writing normal progress to stderr", async () => {
    const fixture = writeRunnerCommandFixture({
      runId: "run-logs",
      tempPrefix: "runner-command-logs-",
    });
    const mocks = installMockState();
    mocks.runScheduledWorkflowTask.mockResolvedValue({
      evidence: [],
      exitCode: 0,
      output: "ok",
      status: "passed",
    });
    mocks.prepareRunnerGitWorkspace.mockResolvedValue(fixture.dir);
    mocks.mergeDependencyRefs.mockResolvedValue(RESOLVED_VALUE);
    mocks.commitAndPushNodeRef.mockResolvedValue(RESOLVED_VALUE);
    const fetch = vi.fn(
      async () => await Promise.resolve(new Response(null, { status: 202 }))
    );
    const stdout = captureOutput();
    const stderr = captureOutput();

    const exitCode = await runRunnerCommand({
      cwd: fixture.dir,
      fetch,
      payloadFile: fixture.payloadPath,
      scheduleFile: fixture.schedulePath,
      stderr: stderr.stream,
      stdout: stdout.stream,
      taskDescriptorFile: fixture.descriptorPath,
    });

    expect(exitCode).toBe(0);
    expect(logPhases(stdout.text())).toEqual(
      expect.arrayContaining([
        "payload.load:finish",
        "git.workspace.prepare:start",
        "task.run:start",
        "git.node-ref.push:finish",
        "event.flush:finish",
      ])
    );
    expect(stdout.text()).not.toContain("test-token");
    expect(stderr.text()).toBe("");
  });

  it("writes failed task output to stderr through the structured logger", async () => {
    const fixture = writeRunnerCommandFixture({
      runId: "run-failed-logs",
      tempPrefix: "runner-command-failed-logs-",
    });
    const mocks = installMockState();
    mocks.runScheduledWorkflowTask.mockResolvedValue({
      evidence: ["agent stderr: model unavailable"],
      exitCode: 1,
      output: "agent failed before producing research",
      status: "failed",
    });
    mocks.prepareRunnerGitWorkspace.mockResolvedValue(fixture.dir);
    mocks.mergeDependencyRefs.mockResolvedValue(RESOLVED_VALUE);
    mocks.commitAndPushNodeRef.mockResolvedValue(RESOLVED_VALUE);
    const fetch = vi.fn(
      async () => await Promise.resolve(new Response(null, { status: 202 }))
    );
    const stdout = captureOutput();
    const stderr = captureOutput();

    const exitCode = await runRunnerCommand({
      cwd: fixture.dir,
      fetch,
      payloadFile: fixture.payloadPath,
      scheduleFile: fixture.schedulePath,
      stderr: stderr.stream,
      stdout: stdout.stream,
      taskDescriptorFile: fixture.descriptorPath,
    });

    expect(exitCode).toBe(1);
    expect(logPhases(stdout.text())).toContain("task.run:finish");
    expect(logRecords(stderr.text())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: ["agent stderr: model unavailable"],
          level: 50,
          output: "agent failed before producing research",
          phase: "task.run",
          status: "failed",
        }),
      ])
    );
  });
});
