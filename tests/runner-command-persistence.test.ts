import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNextNodeEnvelope } from "../src/run-control/next-node";
import {
  fileRunControlStore,
  type RunControlStore,
} from "../src/run-control/run-control-store";
import { runRunnerCommand } from "../src/runner-command/run";
import type {
  PipelineRuntimeEvent,
  RuntimeNodeResult,
} from "../src/runtime/contracts";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import type { WorkflowScheduleNode } from "../src/runtime/scheduler";
import {
  cleanupRunnerCommandFixtures,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

interface RunnerPersistenceMocks {
  commitAndPushNodeRef: ReturnType<typeof vi.fn>;
  mergeDependencyRefs: ReturnType<typeof vi.fn>;
  prepareRunnerGitWorkspace: ReturnType<typeof vi.fn>;
  runScheduledWorkflowTask: ReturnType<typeof vi.fn>;
}

function mockState(): RunnerPersistenceMocks {
  return (
    globalThis as typeof globalThis & {
      __runnerPersistenceMocks: RunnerPersistenceMocks;
    }
  ).__runnerPersistenceMocks;
}

function installMockState(): RunnerPersistenceMocks {
  const state = {
    commitAndPushNodeRef: vi.fn(),
    mergeDependencyRefs: vi.fn(),
    prepareRunnerGitWorkspace: vi.fn(),
    runScheduledWorkflowTask: vi.fn(),
  };
  (
    globalThis as typeof globalThis & {
      __runnerPersistenceMocks: RunnerPersistenceMocks;
    }
  ).__runnerPersistenceMocks = state;
  return state;
}

vi.mock("../src/pipeline-runtime", () => ({
  runScheduledWorkflowTask: (...args: unknown[]) =>
    mockState().runScheduledWorkflowTask(...args),
}));

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ exitCode: 0 })),
}));

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
  (
    globalThis as typeof globalThis & {
      __runnerPersistenceMocks?: RunnerPersistenceMocks;
    }
  ).__runnerPersistenceMocks = undefined;
  cleanupRunnerCommandFixtures();
});

const PASSED_RESULT: RuntimeNodeResult = {
  attempts: 1,
  evidence: [],
  exitCode: 0,
  nodeId: "command",
  output: "node A output",
  status: "passed",
};

// Faithfully simulate runScheduledWorkflowTask: emit the node.start/node.finish
// events the real executor emits (via emitNodeStart/emitNodeFinish) so the
// run-control projection sees the terminal status, then return the result.
function executeEmittingResult(result: RuntimeNodeResult) {
  return (options: {
    nodeId: string;
    reporter?: (event: PipelineRuntimeEvent) => void;
  }) => {
    options.reporter?.({
      attempt: 1,
      nodeId: options.nodeId,
      type: "node.start",
    });
    options.reporter?.({
      attempt: result.attempts,
      exitCode: result.exitCode,
      nodeId: options.nodeId,
      status: result.status,
      type: "node.finish",
    });
    return Promise.resolve(result);
  };
}

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

describe("runner-command durable persistence (PIPE-94.6)", () => {
  it("AC1: records the executed RuntimeNodeResult in the DurableRunStore", async () => {
    const fixture = writeRunnerCommandFixture({
      runId: "run-persist",
      tempPrefix: "runner-command-persist-",
    });
    const mocks = installMockState();
    mocks.runScheduledWorkflowTask.mockImplementation(
      executeEmittingResult(PASSED_RESULT)
    );
    mocks.prepareRunnerGitWorkspace.mockResolvedValue(fixture.dir);
    mocks.mergeDependencyRefs.mockResolvedValue(undefined);
    mocks.commitAndPushNodeRef.mockResolvedValue(undefined);
    const durableStore = inMemoryDurableRunStore();
    const runControlStore = fileRunControlStore(join(fixture.dir, "store"));
    await createRun(runControlStore, "run-persist", ["command"]);

    const exitCode = await runRunnerCommand({
      cwd: fixture.dir,
      fetch: async () => new Response(null, { status: 202 }),
      payloadFile: fixture.payloadPath,
      resolvePersistence: () =>
        Effect.succeed({ durableStore, runControlStore }),
      scheduleFile: fixture.schedulePath,
      stderr: { write: () => true },
      stdout: { write: () => true },
      taskDescriptorFile: fixture.descriptorPath,
    });

    expect(exitCode).toBe(0);
    expect(durableStore.get("run-persist", "command")?.result).toEqual(
      PASSED_RESULT
    );
  });

  it("AC2: run-control node status reflects pass and the durable record advances next node to B", async () => {
    const fixture = writeRunnerCommandFixture({
      runId: "run-advance",
      tempPrefix: "runner-command-advance-",
    });
    const mocks = installMockState();
    mocks.runScheduledWorkflowTask.mockImplementation(
      executeEmittingResult(PASSED_RESULT)
    );
    mocks.prepareRunnerGitWorkspace.mockResolvedValue(fixture.dir);
    mocks.mergeDependencyRefs.mockResolvedValue(undefined);
    mocks.commitAndPushNodeRef.mockResolvedValue(undefined);
    const durableStore = inMemoryDurableRunStore();
    const runControlStore = fileRunControlStore(join(fixture.dir, "store"));
    await createRun(runControlStore, "run-advance", ["command", "b"]);

    const exitCode = await runRunnerCommand({
      cwd: fixture.dir,
      fetch: async () => new Response(null, { status: 202 }),
      payloadFile: fixture.payloadPath,
      resolvePersistence: () =>
        Effect.succeed({ durableStore, runControlStore }),
      scheduleFile: fixture.schedulePath,
      stderr: { write: () => true },
      stdout: { write: () => true },
      taskDescriptorFile: fixture.descriptorPath,
    });

    expect(exitCode).toBe(0);
    const manifest = await Effect.runPromise(
      runControlStore.readRun({ runId: "run-advance" })
    );
    expect(manifest?.nodes.command).toBe("passed");

    // A two-node graph A(command) -> B: now A is recorded as passed, the shared
    // next-node selector must surface B's envelope, proving the runner's durable
    // write advances the run.
    const nodes: WorkflowScheduleNode[] = [
      { dependents: ["b"], id: "command", index: 0, needs: [] },
      { dependents: [], id: "b", index: 1, needs: ["command"] },
    ];
    const envelope = buildNextNodeEnvelope({
      nodeMetadata: new Map(),
      nodes,
      runId: "run-advance",
      store: durableStore,
    });
    expect(envelope?.nodeId).toBe("b");
    expect(envelope?.upstreamOutputs).toEqual([
      { nodeId: "command", output: "node A output" },
    ]);
  });

  it("AC3: db.url absent -> identical exit code, no persistence, skip logged", async () => {
    const fixture = writeRunnerCommandFixture({
      runId: "run-nodb",
      tempPrefix: "runner-command-nodb-",
    });
    const mocks = installMockState();
    mocks.runScheduledWorkflowTask.mockImplementation(
      executeEmittingResult(PASSED_RESULT)
    );
    mocks.prepareRunnerGitWorkspace.mockResolvedValue(fixture.dir);
    mocks.mergeDependencyRefs.mockResolvedValue(undefined);
    mocks.commitAndPushNodeRef.mockResolvedValue(undefined);
    const stdout = captureOutput();

    const savedMokaDbUrl = process.env.MOKA_DB_URL;
    delete process.env.MOKA_DB_URL;
    let exitCode = -1;
    try {
      exitCode = await runRunnerCommand({
        cwd: fixture.dir,
        fetch: async () => new Response(null, { status: 202 }),
        payloadFile: fixture.payloadPath,
        // No resolvePersistence override — exercises the real db.url guard.
        scheduleFile: fixture.schedulePath,
        stderr: { write: () => true },
        stdout: stdout.stream,
        taskDescriptorFile: fixture.descriptorPath,
      });
    } finally {
      if (savedMokaDbUrl !== undefined) {
        process.env.MOKA_DB_URL = savedMokaDbUrl;
      }
    }

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("db.url not configured");
  });
});

function createRun(
  store: RunControlStore,
  runId: string,
  nodeIds: string[]
): Promise<unknown> {
  return Effect.runPromise(
    store.createRun({
      effort: "normal",
      mode: "write",
      nodeIds,
      runId,
      schedule: `schedule_id: ${runId}`,
      target: "remote",
    })
  );
}
