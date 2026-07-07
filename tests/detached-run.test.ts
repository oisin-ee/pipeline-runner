import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import * as Option from "effect/Option";
import * as R from "effect/Record";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { generateScheduleArtifactInMemory } from "../src/planning/generate";
import type {
  MokaNodeStatus,
  MokaRunStatus,
} from "../src/run-control/contracts";
import type {
  fileRunControlStore,
  withRunControlStoreScoped,
} from "../src/run-control/run-control-store";
import { isNumberValue, isStringValue } from "../src/safe-json";
import {
  isObjectValue,
  stringValue,
  taggedErrorClass,
} from "../src/schema-boundary";
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
  schedule?: string;
}

interface MockSpawnOptions {
  readonly cwd?: string | URL;
  readonly detached?: boolean;
  readonly stdio?: unknown;
}

type ChildProcessModule = Record<string, unknown> & {
  readonly spawn: (
    command: string,
    argsOrOptions?: readonly string[] | MockSpawnOptions,
    maybeOptions?: MockSpawnOptions
  ) => MockSpawnedController;
};

type PlanningGenerateModule = Record<string, unknown> & {
  readonly generateScheduleArtifactInMemory: typeof generateScheduleArtifactInMemory;
};

type RunControlStoreModule = Record<string, unknown> & {
  readonly fileRunControlStore: typeof fileRunControlStore;
  readonly withRunControlStoreScoped: typeof withRunControlStoreScoped;
};

const DETACHED_CONTROLLER_PID = 42_424;
const CONTROLLER_ARGV_RE = /controller/iu;
const RAW_OPENCODE_RUN_RE = /\bopencode\s+run\b/iu;
const RUN_ID_OUTPUT_RE = /Run id:\s*(run-[\w.-]+)/iu;

const isSpawnArgs = (value: unknown): value is readonly string[] =>
  Array.isArray(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectValue(value) && !Array.isArray(value);

const spawnCwd = (cwd: MockSpawnOptions["cwd"]): Option.Option<string> =>
  Option.fromNullishOr(cwd).pipe(Option.map((value) => value.toString()));

class DetachedRunTestError extends taggedErrorClass<DetachedRunTestError>()(
  "DetachedRunTestError",
  {
    message: stringValue(),
  }
) {}

const detachedRunTestError = (message: string): DetachedRunTestError =>
  new DetachedRunTestError({ message });

type MockSpawnListener = (...args: readonly unknown[]) => void;

interface MockSpawnListenerEntry {
  readonly eventListener: EventListener;
  readonly eventName: string;
  readonly listener: MockSpawnListener;
}

interface MockSpawnedController {
  readonly pid: number;
  dispatchEvent(event: Event): boolean;
  off(eventName: string, listener: MockSpawnListener): MockSpawnedController;
  once(eventName: string, listener: MockSpawnListener): MockSpawnedController;
  unref(): void;
}

const makeMockSpawnedController = (): MockSpawnedController => {
  const target = new EventTarget();
  let listeners: MockSpawnListenerEntry[] = [];
  const controller: MockSpawnedController = {
    dispatchEvent: (event) => target.dispatchEvent(event),
    off: (eventName, listener) => {
      const entry = listeners.find(
        (item) => item.eventName === eventName && item.listener === listener
      );
      if (entry !== undefined) {
        target.removeEventListener(eventName, entry.eventListener);
        listeners = listeners.filter((item) => item !== entry);
      }
      return controller;
    },
    once: (eventName, listener) => {
      const eventListener = (): void => {
        listener();
      };
      listeners = [...listeners, { eventListener, eventName, listener }];
      target.addEventListener(eventName, eventListener, { once: true });
      return controller;
    },
    pid: DETACHED_CONTROLLER_PID,
    unref: vi.fn(() => {}),
  };
  return controller;
};

interface DetachedMockState {
  runtimeCalls: unknown[];
  spawnCalls: SpawnCall[];
  stderr: string[];
  stdout: string[];
}

const mockState = vi.hoisted(
  (): DetachedMockState => ({
    runtimeCalls: [],
    spawnCalls: [],
    stderr: [],
    stdout: [],
  })
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<ChildProcessModule>();

  return {
    ...actual,
    spawn: vi.fn(
      (
        command: string,
        argsOrOptions?: readonly string[] | MockSpawnOptions,
        maybeOptions?: MockSpawnOptions
      ) => {
        const args = isSpawnArgs(argsOrOptions) ? [...argsOrOptions] : [];
        const options = isSpawnArgs(argsOrOptions)
          ? maybeOptions
          : argsOrOptions;
        const child = makeMockSpawnedController();
        mockState.spawnCalls.push({
          args,
          command,
          options: {
            cwd: Option.getOrUndefined(spawnCwd(options?.cwd)),
            detached: options?.detached,
            stdio: options?.stdio,
          },
        });
        queueMicrotask(() => {
          child.dispatchEvent(new Event("spawn"));
        });

        return child;
      }
    ),
  };
});

vi.mock("../src/pipeline-runtime", () => ({
  runPipelineFromConfig: vi.fn((input: unknown) => {
    mockState.runtimeCalls.push(input);
    throw detachedRunTestError(
      "detached run must not invoke the in-process runtime"
    );
  }),
}));

vi.mock("../src/run-control/run-control-store", async (importOriginal) => {
  const actual = await importOriginal<RunControlStoreModule>();

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

const runMokaInTarget = async (workspaceRoot: string, args: string[]) => {
  const stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      mockState.stdout.push(String(chunk));
      return true;
    });
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      mockState.stderr.push(String(chunk));
      return true;
    });
  try {
    return await runMokaCliInTarget({
      args,
      buffers: mockState,
      originalPipelineTargetPath: ORIGINAL_PIPELINE_TARGET_PATH,
      workspaceRoot,
    });
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
};

const seedDetachedRun = (
  workspaceRoot: string,
  input: {
    nodes: Record<string, MokaNodeStatus>;
    pid: number;
    runId: string;
    status: MokaRunStatus;
  }
): void => {
  const runRoot = join(workspaceRoot, ".pipeline", "runs", input.runId);
  mkdirSync(join(runRoot, "nodes"), { recursive: true });
  for (const nodeId of R.keys(input.nodes)) {
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
  writeFileSync(join(runRoot, "events.jsonl"), "", "utf-8");
};

const extractRunId = (output: string): string => {
  const match = RUN_ID_OUTPUT_RE.exec(output);
  if (!match) {
    throw detachedRunTestError(
      `Detached run output did not include a run id: ${output}`
    );
  }
  return match[1];
};

const requiredRecordField = (
  record: Record<string, unknown>,
  field: string,
  context: string
): Record<string, unknown> => {
  const value = record[field];
  if (!isRecord(value)) {
    throw detachedRunTestError(`Expected detached ${context} at ${field}`);
  }
  return value;
};

const requiredStringField = (
  record: Record<string, unknown>,
  field: string,
  context: string
): string => {
  const value = record[field];
  if (!isStringValue(value)) {
    throw detachedRunTestError(`Expected detached ${context} at ${field}`);
  }
  return value;
};

const optionalSchedulePatch = (
  record: Record<string, unknown>
): Partial<Pick<DetachedManifest, "schedule">> => {
  const value = record.schedule;
  return isStringValue(value) ? { schedule: value } : {};
};

const requiredNumberField = (
  record: Record<string, unknown>,
  field: string,
  context: string
): number => {
  const value = record[field];
  if (!isNumberValue(value)) {
    throw detachedRunTestError(`Expected detached ${context} at ${field}`);
  }
  return value;
};

const requiredStringArrayField = (
  record: Record<string, unknown>,
  field: string,
  context: string
): string[] => {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw detachedRunTestError(`Expected detached ${context} at ${field}`);
  }
  return value.map(String);
};

const readDetachedControllerPaths = (
  controller: Record<string, unknown>,
  manifestPath: string
): DetachedManifest["controller"]["paths"] => {
  const paths = requiredRecordField(
    controller,
    "paths",
    `controller paths in ${manifestPath}`
  );
  return {
    events: requiredStringField(
      paths,
      "events",
      `controller path string in ${manifestPath}`
    ),
    manifest: requiredStringField(
      paths,
      "manifest",
      `controller path string in ${manifestPath}`
    ),
    status: requiredStringField(
      paths,
      "status",
      `controller path string in ${manifestPath}`
    ),
  };
};

const readDetachedController = (
  manifest: Record<string, unknown>,
  manifestPath: string
): DetachedManifest["controller"] => {
  const controller = requiredRecordField(
    manifest,
    "controller",
    `controller metadata in ${manifestPath}`
  );
  return {
    argv: requiredStringArrayField(
      controller,
      "argv",
      `controller metadata in ${manifestPath}`
    ),
    cwd: requiredStringField(
      controller,
      "cwd",
      `controller metadata in ${manifestPath}`
    ),
    paths: readDetachedControllerPaths(controller, manifestPath),
    pid: requiredNumberField(
      controller,
      "pid",
      `controller metadata in ${manifestPath}`
    ),
    startedAt: requiredStringField(
      controller,
      "startedAt",
      `controller paths in ${manifestPath}`
    ),
  };
};

const readDetachedManifest = (path: string): DetachedManifest => {
  const value = readJson(path);
  if (!isRecord(value)) {
    throw detachedRunTestError(`Expected detached manifest at ${path}`);
  }
  return {
    controller: readDetachedController(value, path),
    runId: requiredStringField(value, "runId", `manifest in ${path}`),
    ...optionalSchedulePatch(value),
  };
};

const workspaceRelative = (workspaceRoot: string, value: string): string => {
  const fullPath = isAbsolute(value) ? value : join(workspaceRoot, value);
  return relative(workspaceRoot, fullPath).split(sep).join("/");
};

const detachedScheduleYaml = (input: {
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
  ].join("\n");

vi.mock("../src/planning/generate", async (importOriginal) => {
  const actual = await importOriginal<PlanningGenerateModule>();

  return {
    ...actual,
    generateScheduleArtifactInMemory: vi.fn(
      (input: {
        entrypointId: string;
        runId: string;
        task: string;
        worktreePath: string;
      }) => ({
        yaml: detachedScheduleYaml({
          command: "console.log('detached writer')",
          nodeId: "writer",
          rootWorkflowId: "detached-root",
          runId: input.runId,
          task: input.task,
        }),
      })
    ),
  };
});

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
    const [spawnCall] = mockState.spawnCalls;
    expect(spawnCall.options).toMatchObject({
      cwd: workspaceRoot,
      detached: true,
    });

    const launchedArgv = [spawnCall.command, ...spawnCall.args];
    expect(launchedArgv.join(" ")).toMatch(CONTROLLER_ARGV_RE);
    expect(launchedArgv.join(" ")).not.toMatch(RAW_OPENCODE_RUN_RE);
    expect(launchedArgv).not.toContain("--schedule");

    const runId = extractRunId(capture.stdout);
    const manifest = readDetachedManifest(
      join(workspaceRoot, ".pipeline", "runs", runId, "manifest.json")
    );

    expect(manifest.runId).toBe(runId);
    expect(manifest.controller).toMatchObject({
      argv: launchedArgv,
      cwd: workspaceRoot,
      pid: DETACHED_CONTROLLER_PID,
    });
    expect(manifest.schedule).toContain("kind: pipeline-schedule");
    expect(manifest.schedule).toContain("schedule_id: run-");
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
    expect(
      existsSync(
        join(workspaceRoot, ".pipeline", "runs", runId, "schedule.yaml")
      )
    ).toBe(false);
  });

  it("persists explicit schedule YAML while forwarding the approved path to the controller", async () => {
    const schedulePath = join(workspaceRoot, "approved-detached-schedule.yaml");
    writeFileSync(
      schedulePath,
      detachedScheduleYaml({
        command: "console.log('explicit detached writer')",
        nodeId: "explicit-writer",
        rootWorkflowId: "explicit-detached-root",
        runId: "approved-detached",
        task: "Ticket 8 detached explicit schedule",
      }),
      "utf-8"
    );

    const capture = await runMokaInTarget(workspaceRoot, [
      "run",
      "Ticket 8 detached explicit schedule",
      "--detach",
      "--schedule",
      schedulePath,
    ]);

    expect(capture.thrown).toBeUndefined();
    expect(mockState.spawnCalls).toHaveLength(1);
    const [spawnCall] = mockState.spawnCalls;
    const launchedArgv = [spawnCall.command, ...spawnCall.args];
    expect(launchedArgv).toContain("--schedule");
    expect(launchedArgv).toContain(schedulePath);

    const runId = extractRunId(capture.stdout);
    expect(
      readJson(join(workspaceRoot, ".pipeline", "runs", runId, "manifest.json"))
    ).toMatchObject({
      schedule: expect.stringContaining("schedule_id: approved-detached"),
    });
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
          ([pid]) => Math.abs(pid) === DETACHED_CONTROLLER_PID
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
