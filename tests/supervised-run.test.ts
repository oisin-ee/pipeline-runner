import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfigParts } from "../src/config";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
} from "../src/pipeline-runtime";
import {
  type MokaRunManifest,
  parseMokaRunManifest,
} from "../src/run-control/contracts";
import { buildNextNodeEnvelopeFromRunStore } from "../src/run-control/next-node";
import { fileRunControlStore } from "../src/run-control/run-control-store";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import { readRun } from "./run-control-file-store-helpers";
import {
  readJson,
  readJsonl,
  restoreEnv,
  runMokaCliInTarget,
} from "./run-control-test-helpers";

interface RuntimeObservation {
  eventsFileExistedBeforeRuntimeStart: boolean;
  immediateOutputBeforeRuntimeStart: boolean;
  manifestBeforeRuntime?: MokaRunManifest;
  manifestExistedBeforeRuntimeStart: boolean;
  outputBeforeRuntimeStart: string;
  runId: string;
}

const mockState = vi.hoisted(() => ({
  runtimeCalls: [] as RuntimeObservation[],
  supervisedScheduleYaml: (input: {
    command: string;
    nodeId: string;
    rootWorkflowId: string;
    runId: string;
    task: string;
  }): string =>
    [
      "version: 1",
      "kind: pipeline-schedule",
      `schedule_id: ${input.runId}`,
      "source_entrypoint: execute",
      `task: ${input.task}`,
      "generated_at: 2026-06-17T00:00:00.000Z",
      `root_workflow: ${input.rootWorkflowId}`,
      "workflows:",
      `  ${input.rootWorkflowId}:`,
      "    nodes:",
      `      - id: ${input.nodeId}`,
      "        kind: command",
      `        command: [node, -e, "${input.command}"]`,
      "",
    ].join("\n"),
  stderr: [] as string[],
  stdout: [] as string[],
}));

const NEXT_NODE_CONFIG = parsePipelineConfigParts({
  pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: package-default
        kind: command
        command: ["node", "-e", "console.log('wrong graph')"]
`,
  profiles: `
version: 1
profiles:
  orchestrator:
    runner: command
    instructions: { inline: Orchestrate }
`,
  runners: `
version: 1
runners:
  command:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
});

vi.mock("../src/planning/generate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/planning/generate")>();

  // The foreground run path (run-service) generates its schedule via
  // generateScheduleArtifactInMemory, not the path-returning
  // generateScheduleArtifact wrapper. Mock the in-memory function (as
  // detached-run.test.ts does) so the supervisor exercises a deterministic
  // single-node schedule instead of invoking the live planner model.
  return {
    ...actual,
    generateScheduleArtifactInMemory: vi.fn(
      (input: {
        entrypointId: string;
        runId: string;
        task: string;
        worktreePath: string;
      }) =>
        Promise.resolve({
          yaml: mockState.supervisedScheduleYaml({
            command: "console.log('writer')",
            nodeId: "writer",
            rootWorkflowId: "supervised-root",
            runId: input.runId,
            task: input.task,
          }),
        })
    ),
  };
});

vi.mock("../src/pipeline-runtime", () => ({
  runPipelineFromConfig: vi.fn((options: PipelineRuntimeOptions) => {
    const runId = options.runId ?? "missing-run-id";
    const runRoot = join(
      options.worktreePath ?? process.cwd(),
      ".pipeline",
      "runs",
      runId
    );
    const manifestPath = join(runRoot, "manifest.json");
    const outputBeforeRuntimeStart = [
      mockState.stdout.join(""),
      mockState.stderr.join(""),
    ].join("\n");
    const manifestExistedBeforeRuntimeStart = existsSync(manifestPath);
    const manifestBeforeRuntime = manifestExistedBeforeRuntimeStart
      ? parseMokaRunManifest(readJson(manifestPath))
      : undefined;

    mockState.runtimeCalls.push({
      eventsFileExistedBeforeRuntimeStart: existsSync(
        join(runRoot, "events.jsonl")
      ),
      immediateOutputBeforeRuntimeStart:
        outputBeforeRuntimeStart.includes(runId) &&
        outputBeforeRuntimeStart.includes(`moka status ${runId}`) &&
        outputBeforeRuntimeStart.includes(`moka logs ${runId}`),
      manifestBeforeRuntime,
      manifestExistedBeforeRuntimeStart,
      outputBeforeRuntimeStart,
      runId,
    });

    for (const event of supervisedFailureEvents()) {
      options.reporter?.(event);
    }

    return Promise.resolve(supervisedFailureResult());
  }),
}));

// The foreground run resolves the run-control store via withRunControlStoreScoped,
// which requires db.url (PIPE-91.18, Postgres-only). These tests exercise the
// supervisor orchestration against the file store double — the same DI-via-mock
// pattern detached-run/cli use — so no live Postgres is needed.
vi.mock("../src/run-control/run-control-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/run-control/run-control-store")
    >();

  return {
    ...actual,
    withRunControlStoreScoped: vi.fn(
      (
        workspaceRoot: string,
        use: Parameters<typeof actual.withRunControlStoreScoped>[1]
      ) => use(actual.fileRunControlStore(workspaceRoot))
    ),
  };
});

const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;

describe("foreground supervised moka run", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "moka-supervised-run-"));
    mockState.runtimeCalls.length = 0;
    mockState.stderr.length = 0;
    mockState.stdout.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("creates the run manifest and prints inspect commands before runtime starts", async () => {
    const capture = await runMokaInTarget(workspaceRoot, [
      "run",
      "Ticket",
      "7",
      "supervised",
      "failure",
    ]);

    expect(capture.thrown).toBeInstanceOf(Error);
    expect(mockState.runtimeCalls).toHaveLength(1);
    const runtimeStart = mockState.runtimeCalls[0];
    expect(runtimeStart.manifestExistedBeforeRuntimeStart).toBe(true);
    expect(runtimeStart.eventsFileExistedBeforeRuntimeStart).toBe(true);
    expect(runtimeStart.manifestBeforeRuntime).toMatchObject({
      effort: "normal",
      mode: "write",
      nodes: { writer: "queued" },
      runId: runtimeStart.runId,
      status: "queued",
      target: "local",
    });
    expect(runtimeStart.immediateOutputBeforeRuntimeStart).toBe(true);
    expect(runtimeStart.outputBeforeRuntimeStart).toContain(
      `moka status ${runtimeStart.runId}`
    );
    expect(runtimeStart.outputBeforeRuntimeStart).toContain(
      `moka logs ${runtimeStart.runId}`
    );
  });

  it("persists generated schedule so next-node can reconstruct the first ready node", async () => {
    const capture = await runMokaInTarget(workspaceRoot, [
      "run",
      "Ticket",
      "7",
      "next-node",
      "schedule",
    ]);

    expect(capture.thrown).toBeInstanceOf(Error);
    expect(mockState.runtimeCalls).toHaveLength(1);
    const runtimeStart = mockState.runtimeCalls[0];
    expect(runtimeStart.manifestBeforeRuntime?.schedule).toContain(
      "kind: pipeline-schedule"
    );
    expect(runtimeStart.manifestBeforeRuntime?.schedule).toContain("writer");

    await expect(
      buildLocalRunFirstNextNode({
        runId: runtimeStart.runId,
        workspaceRoot,
      })
    ).resolves.toEqual({
      criteria: [],
      nodeId: "writer",
      prompt: "writer",
      runId: runtimeStart.runId,
      upstreamOutputs: [],
    });
  });

  it("streams progress, persists events and artifacts, and leaves failure follow-ups", async () => {
    const capture = await runMokaInTarget(workspaceRoot, [
      "run",
      "Ticket",
      "7",
      "durable",
      "failure",
    ]);

    expect(capture.thrown).toBeInstanceOf(Error);
    expect(mockState.runtimeCalls).toHaveLength(1);
    const runId = mockState.runtimeCalls[0].runId;
    const run = await readRun({ runId, workspaceRoot });
    const commandOutput = [
      capture.stdout,
      capture.stderr,
      errorMessage(capture.thrown),
    ].join("\n");

    expect(commandOutput).toContain("Pipeline starting: supervised-root");
    expect(commandOutput).toContain("Node output: writer");
    expect(run).toMatchObject({
      nodes: { writer: "failed" },
      runId,
      status: "failed",
    });
    expect(
      readJsonl(join(workspaceRoot, ".pipeline", "runs", runId, "events.jsonl"))
    ).toEqual([
      expect.objectContaining({ status: "starting", type: "run.status" }),
      expect.objectContaining({
        nodeId: "writer",
        status: "running",
        type: "node.status",
      }),
      expect.objectContaining({
        nodeId: "writer",
        status: "failed",
        type: "node.status",
      }),
      expect.objectContaining({ status: "failed", type: "run.status" }),
    ]);
    expect(
      readJsonl(
        join(workspaceRoot, ".pipeline", "runs", runId, "runtime-events.jsonl")
      ).map((event) => (event as { type: string }).type)
    ).toEqual([
      "workflow.planned",
      "workflow.start",
      "node.start",
      "node.output.recorded",
      "node.finish",
      "workflow.finish",
    ]);
    expect(
      readJsonl(
        join(
          workspaceRoot,
          ".pipeline",
          "runs",
          runId,
          "nodes",
          "writer",
          "stdout.jsonl"
        )
      )
    ).toEqual([
      expect.objectContaining({
        nodeId: "writer",
        output: "mock durable stdout\n",
        type: "node.output.recorded",
      }),
    ]);
    expect(commandOutput).toContain(`moka status ${runId}`);
    expect(commandOutput).toContain(`moka logs ${runId}`);
  });

  it("keeps the execute export compatible with injected programmatic runners", async () => {
    const { execute } = await import("../src/index");
    const runtimeCalls: PipelineRuntimeOptions[] = [];
    process.env.PIPELINE_TARGET_PATH = workspaceRoot;

    await expect(
      execute("programmatic supervised run", {
        pipelineRunner: (options) => {
          runtimeCalls.push(options);
          options.reporter?.({
            nodeIds: ["programmatic"],
            type: "workflow.start",
            workflowId: "inspect",
          });
          options.reporter?.({
            outcome: "PASS",
            type: "workflow.finish",
            workflowId: "inspect",
          });
          return Promise.resolve(supervisedPassResult());
        },
        workflow: "inspect",
      })
    ).resolves.toBeUndefined();

    expect(runtimeCalls).toHaveLength(1);
    expect(runtimeCalls[0]).toMatchObject({
      task: "programmatic supervised run",
      workflowId: "inspect",
      worktreePath: workspaceRoot,
    });
  });
});

function runMokaInTarget(workspaceRoot: string, args: string[]) {
  return runMokaCliInTarget({
    args,
    buffers: mockState,
    originalPipelineTargetPath: ORIGINAL_PIPELINE_TARGET_PATH,
    workspaceRoot,
  });
}

function buildLocalRunFirstNextNode(input: {
  readonly runId: string;
  readonly workspaceRoot: string;
}) {
  return Effect.runPromise(
    buildNextNodeEnvelopeFromRunStore({
      config: NEXT_NODE_CONFIG,
      durableStore: inMemoryDurableRunStore(),
      runControlStore: fileRunControlStore(input.workspaceRoot),
      runId: input.runId,
      worktreePath: input.workspaceRoot,
    })
  );
}

function supervisedFailureEvents(): PipelineRuntimeEvent[] {
  return [
    {
      edges: [],
      nodes: [{ id: "writer", kind: "command", needs: [] }],
      type: "workflow.planned",
      workflowId: "supervised-root",
    },
    {
      nodeIds: ["writer"],
      type: "workflow.start",
      workflowId: "supervised-root",
    },
    {
      attempt: 1,
      nodeId: "writer",
      type: "node.start",
    },
    {
      attempt: 1,
      format: "text",
      nodeId: "writer",
      output: "mock durable stdout\n",
      type: "node.output.recorded",
    },
    {
      attempt: 1,
      exitCode: 1,
      nodeId: "writer",
      status: "failed",
      type: "node.finish",
    },
    {
      outcome: "FAIL",
      type: "workflow.finish",
      workflowId: "supervised-root",
    },
  ];
}

function supervisedFailureResult(): PipelineRuntimeResult {
  const failure = {
    evidence: ["mock runtime failure evidence"],
    gate: "runtime",
    nodeId: "writer",
    reason: "mock runtime failed",
  };

  return {
    agentInvocations: [],
    failureDetails: [failure],
    gates: [],
    hookFailures: [],
    nodeStates: {
      writer: {
        attempts: 1,
        evidence: ["mock runtime failure evidence"],
        exitCode: 1,
        failure,
        gates: [],
        id: "writer",
        output: "mock runtime output\n",
        status: "failed",
      },
    },
    nodes: [
      {
        attempts: 1,
        evidence: ["mock runtime failure evidence"],
        exitCode: 1,
        nodeId: "writer",
        output: "mock runtime output\n",
        status: "failed",
      },
    ],
    outcome: "FAIL",
    plan: {
      parallelBatches: [],
      topologicalOrder: [],
      workflowId: "supervised-root",
    } as unknown as PipelineRuntimeResult["plan"],
    structuredOutputs: [],
  };
}

function supervisedPassResult(): PipelineRuntimeResult {
  return {
    agentInvocations: [],
    failureDetails: [],
    gates: [],
    hookFailures: [],
    nodeStates: {},
    nodes: [],
    outcome: "PASS",
    plan: {
      parallelBatches: [],
      topologicalOrder: [],
      workflowId: "inspect",
    } as unknown as PipelineRuntimeResult["plan"],
    structuredOutputs: [],
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
