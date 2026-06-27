import type { SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MokaNodeStatus,
  MokaRunStatus,
} from "../src/run-control/contracts";
import { readRun } from "./run-control-file-store-helpers";
import {
  readJson,
  restoreEnv,
  runMokaCliInTarget,
  writeJson,
} from "./run-control-test-helpers";

interface SpawnCall {
  args: string[];
  command: string;
  options: {
    cwd?: string;
    detached?: boolean;
    stdio?: unknown;
  };
}

interface DetachedManifest {
  controller: {
    argv: string[];
    cwd: string;
    paths: {
      events: string;
      manifest: string;
      status: string;
    };
    pid: number;
    startedAt: string;
  };
  runId: string;
}

const DETACHED_CONTROLLER_PID = 42_424;
const CONTROLLER_ARGV_RE = /controller/i;
const RAW_OPENCODE_RUN_RE = /\bopencode\s+run\b/i;
const RUN_ID_OUTPUT_RE = /Run id:\s*(run-[\w.-]+)/i;

const mockState = vi.hoisted(() => ({
  runtimeCalls: [] as unknown[],
  spawnCalls: [] as SpawnCall[],
  stderr: [] as string[],
  stdout: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");

  return {
    ...actual,
    spawn: vi.fn(
      (
        command: string,
        argsOrOptions?: readonly string[] | SpawnOptions,
        maybeOptions?: SpawnOptions
      ) => {
        const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
        const options: SpawnOptions | undefined = Array.isArray(argsOrOptions)
          ? maybeOptions
          : (argsOrOptions as SpawnOptions | undefined);
        const child = new EventEmitter() as InstanceType<
          typeof EventEmitter
        > & {
          pid: number;
          stderr: InstanceType<typeof EventEmitter>;
          stdin: InstanceType<typeof EventEmitter>;
          stdout: InstanceType<typeof EventEmitter>;
          unref: () => void;
        };
        child.pid = DETACHED_CONTROLLER_PID;
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdout = new EventEmitter();
        child.unref = vi.fn();
        mockState.spawnCalls.push({
          args,
          command,
          options: {
            cwd: options?.cwd ? String(options.cwd) : undefined,
            detached: options?.detached,
            stdio: options?.stdio,
          },
        });
        queueMicrotask(() => child.emit("spawn"));

        return child;
      }
    ),
  };
});

vi.mock("../src/pipeline-runtime", () => ({
  runPipelineFromConfig: vi.fn((input: unknown) => {
    mockState.runtimeCalls.push(input);
    throw new Error("detached run must not invoke the in-process runtime");
  }),
}));

vi.mock("../src/planning/generate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/planning/generate")>();
  const { writeMockScheduleArtifact } = await import(
    "./run-control-test-helpers"
  );

  return {
    ...actual,
    generateScheduleArtifact: vi.fn(
      (input: {
        entrypointId: string;
        runId: string;
        task: string;
        worktreePath: string;
      }) => {
        const schedulePath = writeMockScheduleArtifact(input, {
          command: "console.log('detached writer')",
          nodeId: "writer",
          rootWorkflowId: "detached-root",
        });
        return Promise.resolve({ path: schedulePath });
      }
    ),
  };
});

const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;

describe("detached moka run", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "moka-detached-run-"));
    mockState.runtimeCalls.length = 0;
    mockState.spawnCalls.length = 0;
    mockState.stderr.length = 0;
    mockState.stdout.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("starts a supervised controller process and records durable controller metadata", async () => {
    const capture = await runMokaInTarget(workspaceRoot, [
      "run",
      "Ticket 8 detached work",
      "--detach",
    ]);

    expect(capture.thrown).toBeUndefined();
    expect(mockState.runtimeCalls).toEqual([]);
    expect(mockState.spawnCalls).toHaveLength(1);
    const spawnCall = mockState.spawnCalls[0];
    expect(spawnCall.options).toMatchObject({
      cwd: workspaceRoot,
      detached: true,
    });

    const launchedArgv = [spawnCall.command, ...spawnCall.args];
    expect(launchedArgv.join(" ")).toMatch(CONTROLLER_ARGV_RE);
    expect(launchedArgv.join(" ")).not.toMatch(RAW_OPENCODE_RUN_RE);

    const runId = extractRunId(capture.stdout);
    const manifest = readJson(
      join(workspaceRoot, ".pipeline", "runs", runId, "manifest.json")
    ) as DetachedManifest;

    expect(manifest.runId).toBe(runId);
    expect(manifest.controller).toMatchObject({
      argv: launchedArgv,
      cwd: workspaceRoot,
      pid: DETACHED_CONTROLLER_PID,
    });
    expect(Number.isNaN(Date.parse(manifest.controller.startedAt))).toBe(false);
    expect(
      workspaceRelative(workspaceRoot, manifest.controller.paths.manifest)
    ).toBe(`.pipeline/runs/${runId}/manifest.json`);
    expect(
      workspaceRelative(workspaceRoot, manifest.controller.paths.status)
    ).toBe(`.pipeline/runs/${runId}/status.json`);
    expect(
      workspaceRelative(workspaceRoot, manifest.controller.paths.events)
    ).toBe(`.pipeline/runs/${runId}/events.jsonl`);
    expect(
      existsSync(join(workspaceRoot, ".pipeline", "runs", runId, "status.json"))
    ).toBe(true);
    expect(
      existsSync(
        join(workspaceRoot, ".pipeline", "runs", runId, "events.jsonl")
      )
    ).toBe(true);
  });

  it("prints the detached run id with status, logs, and stop commands", async () => {
    const capture = await runMokaInTarget(workspaceRoot, [
      "run",
      "Ticket 8 inspectable detached work",
      "--detach",
    ]);

    expect(capture.thrown).toBeUndefined();
    const runId = extractRunId(capture.stdout);
    expect(capture.stdout).toContain(`Run id: ${runId}`);
    expect(capture.stdout).toContain(`moka status ${runId}`);
    expect(capture.stdout).toContain(`moka logs ${runId}`);
    expect(capture.stdout).toContain(`moka stop ${runId}`);
  });

  it("stops the recorded controller process and aborts active run state", async () => {
    const runId = "run-detached-stop";
    seedDetachedRun(workspaceRoot, {
      nodes: {
        planner: "passed",
        verifier: "queued",
        writer: "running",
      },
      pid: DETACHED_CONTROLLER_PID,
      runId,
      status: "running",
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      const capture = await runMokaInTarget(workspaceRoot, ["stop", runId]);

      expect(capture.thrown).toBeUndefined();
      expect(
        kill.mock.calls.some(
          ([pid]) => Math.abs(Number(pid)) === DETACHED_CONTROLLER_PID
        )
      ).toBe(true);
      expect(capture.stdout).toContain(runId);
      expect(capture.stdout).toContain("aborted");
    } finally {
      kill.mockRestore();
    }

    const stoppedRun = await readRun({ runId, workspaceRoot });
    expect(stoppedRun).toMatchObject({
      nodes: {
        planner: "passed",
        verifier: "aborted",
        writer: "aborted",
      },
      status: "aborted",
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

function seedDetachedRun(
  workspaceRoot: string,
  input: {
    nodes: Record<string, MokaNodeStatus>;
    pid: number;
    runId: string;
    status: MokaRunStatus;
  }
): void {
  const runRoot = join(workspaceRoot, ".pipeline", "runs", input.runId);
  mkdirSync(join(runRoot, "nodes"), { recursive: true });
  for (const nodeId of Object.keys(input.nodes)) {
    mkdirSync(join(runRoot, "nodes", nodeId), { recursive: true });
  }

  const paths = {
    events: `.pipeline/runs/${input.runId}/events.jsonl`,
    manifest: `.pipeline/runs/${input.runId}/manifest.json`,
    status: `.pipeline/runs/${input.runId}/status.json`,
  };
  const controllerArgv = [
    process.execPath,
    "/repo/dist/index.js",
    "run-controller",
    "--run-id",
    input.runId,
  ];
  writeJson(join(runRoot, "manifest.json"), {
    controller: {
      argv: controllerArgv,
      cwd: workspaceRoot,
      paths,
      pid: input.pid,
      startedAt: "2026-06-17T12:00:00.000Z",
    },
    effort: "normal",
    events: [],
    mode: "write",
    nodes: input.nodes,
    runId: input.runId,
    status: input.status,
    target: "local",
  });
  writeJson(join(runRoot, "status.json"), {
    nodes: input.nodes,
    status: input.status,
  });
  writeFileSync(join(runRoot, "events.jsonl"), "", "utf8");
}

function extractRunId(output: string): string {
  const match = output.match(RUN_ID_OUTPUT_RE);
  if (!match) {
    throw new Error(`Detached run output did not include a run id: ${output}`);
  }
  return match[1];
}

function workspaceRelative(workspaceRoot: string, value: string): string {
  const fullPath = isAbsolute(value) ? value : join(workspaceRoot, value);
  return relative(workspaceRoot, fullPath).split(sep).join("/");
}
