import { afterEach, describe, expect, it, vi } from "vitest";
import { runRunnerCommand } from "../src/runner-command/run";
import {
  cleanupRunnerCommandFixtures,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

interface RunnerCommandPolicyMocks {
  commitAndPushNodeRef: ReturnType<typeof vi.fn>;
  mergeDependencyRefs: ReturnType<typeof vi.fn>;
  prepareRunnerGitWorkspace: ReturnType<typeof vi.fn>;
  runScheduledWorkflowTask: ReturnType<typeof vi.fn>;
}

function mockState(): RunnerCommandPolicyMocks {
  return (
    globalThis as typeof globalThis & {
      __runnerCommandPolicyMocks: RunnerCommandPolicyMocks;
    }
  ).__runnerCommandPolicyMocks;
}

function installMockState(): RunnerCommandPolicyMocks {
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
}

vi.mock("../src/pipeline-runtime", () => ({
  runScheduledWorkflowTask: (...args: unknown[]) =>
    mockState().runScheduledWorkflowTask(...args),
}));

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ exitCode: 0 })),
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
  (
    globalThis as typeof globalThis & {
      __runnerCommandPolicyMocks?: RunnerCommandPolicyMocks;
    }
  ).__runnerCommandPolicyMocks = undefined;
  cleanupRunnerCommandFixtures();
});

describe("runner-command hook policy", () => {
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
    mocks.mergeDependencyRefs.mockResolvedValue(undefined);
    mocks.commitAndPushNodeRef.mockResolvedValue(undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
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
    mocks.mergeDependencyRefs.mockResolvedValue(undefined);
    mocks.commitAndPushNodeRef.mockResolvedValue(undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
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
});

function captureOutput(): {
  stream: { write: (chunk: string | Uint8Array) => boolean };
  text: () => string;
} {
  let value = "";
  return {
    stream: {
      write: (chunk) => {
        value +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
    text: () => value,
  };
}

function logPhases(content: string): string[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase: string; status: string })
    .map((record) => `${record.phase}:${record.status}`);
}
