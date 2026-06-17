import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
} from "../src/pipeline-runtime";
import type { MokaRunManifest } from "../src/run-control/contracts";
import { readRun } from "../src/run-control/store";

interface RuntimeObservation {
  eventsFileExistedBeforeRuntimeStart: boolean;
  immediateOutputBeforeRuntimeStart: boolean;
  manifestBeforeRuntime?: MokaRunManifest;
  manifestExistedBeforeRuntimeStart: boolean;
  outputBeforeRuntimeStart: string;
  runId: string;
}

interface CliCapture {
  stderr: string;
  stdout: string;
  thrown?: unknown;
}

const mockState = vi.hoisted(() => ({
  runtimeCalls: [] as RuntimeObservation[],
  stderr: [] as string[],
  stdout: [] as string[],
}));

vi.mock("../src/planning/generate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/planning/generate")>();
  const fs = await import("node:fs");
  const path = await import("node:path");

  return {
    ...actual,
    generateScheduleArtifact: vi.fn(
      (input: {
        entrypointId: string;
        runId: string;
        task: string;
        worktreePath: string;
      }) => {
        const schedulePath = `.pipeline/runs/${input.runId}/schedule.yaml`;
        const fullPath = path.join(input.worktreePath, schedulePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(
          fullPath,
          [
            "version: 1",
            "kind: pipeline-schedule",
            `schedule_id: ${input.runId}`,
            `source_entrypoint: ${input.entrypointId}`,
            `task: ${input.task}`,
            "generated_at: 2026-06-17T00:00:00.000Z",
            "root_workflow: supervised-root",
            "workflows:",
            "  supervised-root:",
            "    nodes:",
            "      - id: writer",
            "        kind: command",
            "        command: [node, -e, \"console.log('writer')\"]",
            "",
          ].join("\n")
        );
        return Promise.resolve({ path: schedulePath });
      }
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
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as MokaRunManifest)
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

async function runMokaInTarget(
  workspaceRoot: string,
  args: string[]
): Promise<CliCapture> {
  const { createCliProgram } = await import("../src/cli/program");
  const log = vi.spyOn(console, "log").mockImplementation((...messages) => {
    mockState.stdout.push(`${messages.map(String).join(" ")}\n`);
  });
  const error = vi.spyOn(console, "error").mockImplementation((...messages) => {
    mockState.stderr.push(`${messages.map(String).join(" ")}\n`);
  });
  let thrown: unknown;

  try {
    process.env.PIPELINE_TARGET_PATH = workspaceRoot;
    const program = createCliProgram();
    program.configureOutput({
      writeErr: (value) => mockState.stderr.push(value),
      writeOut: (value) => mockState.stdout.push(value),
    });
    await program.parseAsync(
      ["node", "/repo/node_modules/.bin/moka", ...args],
      {
        from: "node",
      }
    );
  } catch (err) {
    thrown = err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
  }

  return {
    stderr: mockState.stderr.join(""),
    stdout: mockState.stdout.join(""),
    thrown,
  };
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

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
