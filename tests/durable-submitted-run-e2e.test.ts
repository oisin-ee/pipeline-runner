// PIPE-94.9: end-to-end integration test — a SUBMITTED run is durable and
// replayable through the new substrate wiring.
//
// Scenario: two-node graph node-a → node-b (node-b depends on node-a).
//
//   Phase 1 — SUBMIT:   submitMoka upserts createRun + persists schedule to the
//                        run-control store (injected upsertRunRecord, fake Argo).
//   Phase 2 — EXECUTE:  runRunnerCommand for node-a writes the passed result to
//                        the durable store (injected resolvePersistence).
//   Phase 3 — INSPECT:  buildNextNodeEnvelopeFromRunStore reconstructs state from
//                        the durable store and returns node-b as the next ready
//                        node (AC1).
//   Phase 4 — RESUME:   resumeRunByOrigin (remote target) re-submits; the
//                        injected resubmit drives runRunnerCommand for BOTH nodes:
//                        node-a is skipped (already passed in store), node-b
//                        executes; next-node returns undefined after drain (AC2).
//
// No live Postgres or k8s cluster is required. All store I/O is in-memory
// (DurableRunStore) or filesystem (fileRunControlStore). Pg-only paths are not
// exercised here — they are covered by the live-pg suites that gate on
// MOKA_PG_TEST_URL.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadPipelineConfig } from "../src/config";
import { type MokaSubmitOutput, submitMoka } from "../src/moka-submit";
import { resumeRunByOrigin } from "../src/pipeline-runtime";
import { buildNextNodeEnvelopeFromRunStore } from "../src/run-control/next-node";
import {
  fileRunControlStore,
  type RunControlStore,
} from "../src/run-control/run-control-store";
import { buildRemoteRunCreateRequest } from "../src/run-control/run-record";
import { runRunnerCommand } from "../src/runner-command/run";
import type {
  PipelineRuntimeEvent,
  RuntimeNodeResult,
} from "../src/runtime/contracts";
import {
  type DurableRunStore,
  inMemoryDurableRunStore,
} from "../src/runtime/durable-store/durable-store";

// ---------------------------------------------------------------------------
// Module-level config (shared; no project files needed — package defaults).
// ---------------------------------------------------------------------------
const CONFIG_ROOT = mkdtempSync(join(tmpdir(), "e2e-durable-cfg-"));
const CONFIG = loadPipelineConfig(CONFIG_ROOT, {
  allowMissingLintFileReferences: true,
});

afterAll(() => {
  rmSync(CONFIG_ROOT, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Runner mocks — same globalThis pattern as runner-command-persistence.test.ts
// ---------------------------------------------------------------------------
interface RunnerMocks {
  commitAndPushNodeRef: ReturnType<typeof vi.fn>;
  mergeDependencyRefs: ReturnType<typeof vi.fn>;
  prepareRunnerGitWorkspace: ReturnType<typeof vi.fn>;
  runScheduledWorkflowTask: ReturnType<typeof vi.fn>;
}

function mockState(): RunnerMocks {
  return (globalThis as typeof globalThis & { __e2eDurableMocks: RunnerMocks })
    .__e2eDurableMocks;
}

function installMocks(dir: string): RunnerMocks {
  const mocks: RunnerMocks = {
    commitAndPushNodeRef: vi.fn().mockResolvedValue(undefined),
    mergeDependencyRefs: vi.fn().mockResolvedValue(undefined),
    prepareRunnerGitWorkspace: vi.fn().mockResolvedValue(dir),
    runScheduledWorkflowTask: vi.fn(),
  };
  (
    globalThis as typeof globalThis & { __e2eDurableMocks: RunnerMocks }
  ).__e2eDurableMocks = mocks;
  return mocks;
}

// Preserve all pipeline-runtime exports (including resumeRunByOrigin) and only
// intercept runScheduledWorkflowTask so runner pods are simulated without
// spawning real processes.
vi.mock("../src/pipeline-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/pipeline-runtime")>();
  return {
    ...actual,
    runScheduledWorkflowTask: (...args: unknown[]) =>
      mockState().runScheduledWorkflowTask(...args),
  };
});

vi.mock("../src/run-state/git-refs", () => ({
  commitAndPushNodeRef: (...args: unknown[]) =>
    mockState().commitAndPushNodeRef(...args),
  mergeDependencyRefs: (...args: unknown[]) =>
    mockState().mergeDependencyRefs(...args),
  prepareRunnerGitWorkspace: (...args: unknown[]) =>
    mockState().prepareRunnerGitWorkspace(...args),
  // promoteFinalRef is imported by RunnerCommandIoServiceLive but not called
  // in the main runner command path — stub so the import resolves.
  promoteFinalRef: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ exitCode: 0 })),
}));

vi.mock("../src/credentials/runner", () => ({
  prepareOpencodeCredentials: () => ({ brokerConfigured: [] }),
}));

// ---------------------------------------------------------------------------
// Shared schedule fixture — two-node A → B
// ---------------------------------------------------------------------------
const SCHEDULE_ID = "e2e-durable-run";
const WORKFLOW_ID = `schedule-${SCHEDULE_ID}-root`;

const SCHEDULE_YAML = [
  "kind: pipeline-schedule",
  "version: 1",
  `schedule_id: ${SCHEDULE_ID}`,
  "generated_at: 2026-06-29T00:00:00.000Z",
  "source_entrypoint: quick",
  "root_workflow: root",
  'task: "e2e durability proof"',
  "workflows:",
  "  root:",
  "    nodes:",
  "      - id: node-a",
  "        kind: command",
  '        command: ["node", "-e", "console.log(\'node-a\')"]',
  "        task_context:",
  '          description: "Run node A"',
  "      - id: node-b",
  "        kind: command",
  '        command: ["node", "-e", "console.log(\'node-b\')"]',
  "        needs: [node-a]",
  "        task_context:",
  '          description: "Run node B"',
  "",
].join("\n");

function passedResult(nodeId: string): RuntimeNodeResult {
  return {
    attempts: 1,
    evidence: ["exit 0"],
    exitCode: 0,
    nodeId,
    output: `output of ${nodeId}`,
    status: "passed",
  };
}

// Guard helpers — keep the undefined-checks out of the test body so the scenario
// reads as a linear sequence of non-optional assertions (and stays under the
// per-function complexity budget).
async function requireRun(store: RunControlStore, runId: string) {
  const manifest = await Effect.runPromise(store.readRun({ runId }));
  if (manifest === undefined) {
    throw new Error(`expected run ${runId} to exist in the run-control store`);
  }
  return manifest;
}

function requireRecord(store: DurableRunStore, runId: string, nodeId: string) {
  const record = store.get(runId, nodeId);
  if (record === undefined) {
    throw new Error(`expected ${nodeId} to be recorded in the durable store`);
  }
  return record;
}

// runScheduledWorkflowTask mock: faithfully emits node.start + node.finish
// events (the real executor's contract) and resolves with a passed result whose
// nodeId matches the node being executed. This mirrors executeEmittingResult in
// runner-command-persistence.test.ts.
function buildExecutorMock(): (options: {
  nodeId: string;
  reporter?: (event: PipelineRuntimeEvent) => void;
}) => Promise<RuntimeNodeResult> {
  return (options) => {
    const result = passedResult(options.nodeId);
    options.reporter?.({
      attempt: 1,
      nodeId: options.nodeId,
      type: "node.start",
    });
    options.reporter?.({
      attempt: 1,
      exitCode: 0,
      nodeId: options.nodeId,
      status: "passed",
      type: "node.finish",
    });
    return Promise.resolve(result);
  };
}

const FAKE_SUBMISSION: MokaSubmitOutput = {
  namespace: "test-runners",
  payloadConfigMapName: "payload-cm",
  scheduleConfigMapName: "schedule-cm",
  taskDescriptorConfigMapName: "task-cm",
  workflowName: `moka-${SCHEDULE_ID}`,
};

const MANAGED_AUTH = {
  brokerAuth: {
    secretKey: "api-key",
    secretName: "broker-api-key",
    url: "https://cliproxy.momokaya.ee",
  },
  eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
  eventAuthSecretName: "event-auth-secret",
  gitCredentialsSecretName: "git-credentials-secret",
  githubAuthSecretName: "github-auth-secret",
};

const RUN_ID = "e2e-durable-1";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("durable submitted run end-to-end (PIPE-94.9)", () => {
  let dir: string;
  let durableStore: DurableRunStore;
  let runControlStore: RunControlStore;
  let mocks: RunnerMocks;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-durable-run-"));
    durableStore = inMemoryDurableRunStore();
    runControlStore = fileRunControlStore(join(dir, "store"));
    mocks = installMocks(dir);
    mocks.runScheduledWorkflowTask.mockImplementation(buildExecutorMock());
  });

  afterEach(() => {
    vi.clearAllMocks();
    (
      globalThis as typeof globalThis & {
        __e2eDurableMocks?: RunnerMocks;
      }
    ).__e2eDurableMocks = undefined;
    rmSync(dir, { force: true, recursive: true });
  });

  // Write per-node runner fixtures into `dir`. The schedule file and event
  // token are shared (same content); payload + task descriptor are per-node.
  function writeNodeFixture(nodeId: string): {
    descriptorPath: string;
    payloadPath: string;
    schedulePath: string;
  } {
    const eventTokenPath = join(dir, "event-token");
    const schedulePath = join(dir, "schedule.yaml");
    const descriptorPath = join(dir, `${nodeId}-task.json`);
    const payloadPath = join(dir, `${nodeId}-payload.json`);

    writeFileSync(eventTokenPath, "test-token");
    writeFileSync(schedulePath, SCHEDULE_YAML);
    writeFileSync(descriptorPath, JSON.stringify({ nodeId }));
    writeFileSync(
      payloadPath,
      JSON.stringify({
        contractVersion: "1",
        delivery: { pullRequest: false },
        events: {
          authHeader: "Authorization",
          authTokenFile: eventTokenPath,
          url: "https://pipeline-console.example/api/pipeline/runner-events",
        },
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/oisin-ee/test.git",
        },
        run: { id: RUN_ID, project: "test" },
        submission: { argv: ["node", "-e", "true"], kind: "command" },
        task: { kind: "prompt", prompt: "Run node" },
        workflow: { id: WORKFLOW_ID },
      })
    );

    return { descriptorPath, payloadPath, schedulePath };
  }

  // Drive runRunnerCommand for a single node with the shared in-memory stores.
  function runNode(nodeId: string): Promise<number> {
    const { descriptorPath, payloadPath, schedulePath } =
      writeNodeFixture(nodeId);
    return runRunnerCommand({
      cwd: dir,
      fetch: async () => new Response(null, { status: 202 }),
      payloadFile: payloadPath,
      resolvePersistence: () =>
        Effect.succeed({ durableStore, runControlStore }),
      scheduleFile: schedulePath,
      stderr: { write: () => true },
      stdout: { write: () => true },
      taskDescriptorFile: descriptorPath,
    });
  }

  it("submit → execute-A → inspect DB-backed state → resume drains B (AC1, AC2)", async () => {
    // -----------------------------------------------------------------------
    // Phase 1 — SUBMIT
    // -----------------------------------------------------------------------
    // submitMoka with an injected upsertRunRecord that writes to the shared
    // run-control store (same path the live submit service takes via
    // buildRemoteRunCreateRequest). No k8s or Postgres required.
    await submitMoka(
      {
        config: CONFIG,
        ...MANAGED_AUTH,
        eventUrl: "https://example.com/events",
        mode: "quick",
        namespace: "test-runners",
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/oisin-ee/test.git",
        },
        run: { id: RUN_ID, project: "test" },
        scheduleYaml: SCHEDULE_YAML,
        task: "e2e durability proof",
        type: "graph",
      },
      {
        submitWorkflow: async () => FAKE_SUBMISSION,
        upsertRunRecord: async (plan) => {
          await Effect.runPromise(
            runControlStore.createRun(
              buildRemoteRunCreateRequest({
                config: plan.config,
                runId: plan.runId,
                scheduleYaml: plan.scheduleYaml,
              })
            )
          );
        },
      }
    );

    // Assert: run manifest exists with schedule + real node IDs from the schedule.
    const afterSubmit = await requireRun(runControlStore, RUN_ID);
    expect(afterSubmit.schedule).toContain("kind: pipeline-schedule");
    expect(afterSubmit.schedule).toContain(SCHEDULE_ID);
    expect(Object.keys(afterSubmit.nodes)).toContain("node-a");
    expect(Object.keys(afterSubmit.nodes)).toContain("node-b");
    expect(afterSubmit.target).toBe("remote");

    // -----------------------------------------------------------------------
    // Phase 2 — EXECUTE node A (simulates the first Argo pod)
    // -----------------------------------------------------------------------
    const exitA = await runNode("node-a");
    expect(exitA).toBe(0);
    expect(mocks.runScheduledWorkflowTask).toHaveBeenCalledTimes(1);

    // Durable store holds node-a's passed result.
    expect(requireRecord(durableStore, RUN_ID, "node-a").result.status).toBe(
      "passed"
    );
    expect(durableStore.get(RUN_ID, "node-b")).toBeUndefined();

    // -----------------------------------------------------------------------
    // Phase 3 — KILL / INSPECT  (AC1)
    // -----------------------------------------------------------------------
    // "Kill" the run after node-a. buildNextNodeEnvelopeFromRunStore must
    // reconstruct state entirely from the durable store (no in-process cache).
    const envelope = await Effect.runPromise(
      buildNextNodeEnvelopeFromRunStore({
        config: CONFIG,
        durableStore,
        runControlStore,
        runId: RUN_ID,
        worktreePath: dir,
      })
    );

    // AC1a: next-node returns node-b (A settled → B ready).
    if (envelope === undefined) {
      throw new Error(
        "expected next-node to return node-b after node-a passed"
      );
    }
    expect(envelope.nodeId).toBe("node-b");
    expect(envelope.runId).toBe(RUN_ID);
    expect(envelope.upstreamOutputs).toEqual([
      { nodeId: "node-a", output: "output of node-a" },
    ]);

    // AC1b: run-control manifest shows node-a passed, node-b still queued.
    const afterKill = await requireRun(runControlStore, RUN_ID);
    expect(afterKill.nodes["node-a"]).toBe("passed");
    expect(afterKill.nodes["node-b"]).toBe("queued");

    // Reset call counters before the resume phase so assertions are precise.
    mocks.runScheduledWorkflowTask.mockClear();

    // -----------------------------------------------------------------------
    // Phase 4 — RESUME (remote origin)  (AC2)
    // -----------------------------------------------------------------------
    // resumeRunByOrigin reads target=remote from the persisted manifest and
    // calls the injected resubmit. The resubmit simulates Argo re-running ALL
    // nodes under the same runId: node-a is skipped (already passed in the
    // durable store), node-b executes and is recorded.
    const resubmitCalls: string[] = [];

    const result = await resumeRunByOrigin(
      {
        dbUrl: "postgres://stub",
        runId: RUN_ID,
        task: "drain the remaining nodes",
        worktreePath: dir,
      },
      {
        // Inject readManifest so no live Postgres is needed.
        readManifest: async (opts) =>
          Effect.runPromise(runControlStore.readRun({ runId: opts.runId })),
        // Inject resubmit: simulates Argo re-running all pods (same schedule,
        // same runId). Passed nodes are skipped in-pod from the durable store.
        resubmit: async (input) => {
          resubmitCalls.push(input.runId);
          await runNode("node-a"); // already passed → skipped by store check
          await runNode("node-b"); // not yet passed → executes
          return FAKE_SUBMISSION;
        },
      }
    );

    // AC2a: resumed as remote (resubmit was called with the correct runId).
    expect(result.kind).toBe("remote");
    expect(resubmitCalls).toEqual([RUN_ID]);

    // AC2b: node-a was skipped — runScheduledWorkflowTask called only once
    //       (for node-b), not twice.
    expect(mocks.runScheduledWorkflowTask).toHaveBeenCalledTimes(1);
    const [executedCall] = mocks.runScheduledWorkflowTask.mock.calls as [
      [{ nodeId: string }],
      ...unknown[],
    ];
    expect(executedCall[0].nodeId).toBe("node-b");

    // AC2c: node-b is now recorded as passed in the durable store.
    expect(requireRecord(durableStore, RUN_ID, "node-b").result.status).toBe(
      "passed"
    );

    // AC2d: next-node returns undefined — both nodes settled, run fully drained.
    const afterDrain = await Effect.runPromise(
      buildNextNodeEnvelopeFromRunStore({
        config: CONFIG,
        durableStore,
        runControlStore,
        runId: RUN_ID,
        worktreePath: dir,
      })
    );
    expect(afterDrain).toBeUndefined();
  });
});
