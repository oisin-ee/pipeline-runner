import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MokaNodeStatus, MokaRunStatus } from "../src/run-control/contracts";
import {
  createRun,
  readRun,
  updateNodeStatus,
  updateRunStatus,
  writeNodeArtifact,
} from "./run-control-file-store-helpers";
import { restoreEnv, runMokaCliInTarget } from "./run-control-test-helpers";
import type { CliCapture } from "./run-control-test-helpers";

const runtimeState = vi.hoisted(() => ({
  runtimeCalls: [] as unknown[],
}));

vi.mock("../src/pipeline-runtime", () => ({
  runPipelineFromConfig: vi.fn((input: unknown) => {
    runtimeState.runtimeCalls.push(input);
    throw new Error("run-control read commands must not start runtime work");
  }),
}));

vi.mock("../src/run-control/command-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run-control/command-context")>();
  const { fileRunControlStore } = await import("../src/run-control/run-control-store");

  return {
    ...actual,
    withRunControlStore: vi.fn((use: Parameters<typeof actual.withRunControlStore>[0]) => {
      const root = actual.workspaceRoot();
      return use(fileRunControlStore(root), root);
    }),
  };
});

const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;
const ORIGINAL_HOME = process.env.HOME;
const PROMPT_SESSION_SECRET = "PROMPT_SESSION_BODY_TICKET_6_SECRET";
const MULTIPLE_ACTIVE_RUNS_RE = /multiple active runs/iu;
const RUN_ID_TIMESTAMP_RE = /run-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/u;

type FileSnapshot = Record<string, string>;

const runMokaInTarget = async (workspaceRoot: string, args: string[]): Promise<CliCapture> => {
  const buffers: { stderr: string[]; stdout: string[] } = {
    stderr: [],
    stdout: [],
  };
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buffers.stdout.push(String(chunk));
    return true;
  });
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    buffers.stderr.push(String(chunk));
    return true;
  });
  try {
    return await runMokaCliInTarget({
      args,
      buffers,
      originalPipelineTargetPath: ORIGINAL_PIPELINE_TARGET_PATH,
      workspaceRoot,
    });
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
};

const hashText = (value: string): number =>
  Array.from(value).reduce((hash, char) => hash + (char.codePointAt(0) ?? 0), 0);

const eventTimeFor = (runId: string, salt: string): string => {
  const timestamp = RUN_ID_TIMESTAMP_RE.exec(runId);
  if (!timestamp) {
    return "2026-06-17T00:00:00.000Z";
  }
  const [, year, month, day, hour, minute, second] = timestamp;
  const millis = Math.abs(hashText(salt)) % 1000;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(millis).padStart(3, "0")}Z`;
};

const seedRun = async (
  workspaceRoot: string,
  input: {
    artifacts?: Record<string, Record<string, string>>;
    nodeStatuses: Record<string, MokaNodeStatus>;
    runId: string;
    status: MokaRunStatus;
  },
): Promise<void> => {
  const nodeIds = Object.keys(input.nodeStatuses);
  await createRun({
    effort: "normal",
    mode: "write",
    nodeIds,
    runId: input.runId,
    target: "local",
    workspaceRoot,
  });
  for (const [nodeId, status] of Object.entries(input.nodeStatuses)) {
    if (status === "queued") {
      continue;
    }
    await updateNodeStatus({
      at: eventTimeFor(input.runId, nodeId),
      nodeId,
      runId: input.runId,
      status,
      workspaceRoot,
    });
  }
  if (input.status !== "queued") {
    await updateRunStatus({
      at: eventTimeFor(input.runId, "run"),
      runId: input.runId,
      status: input.status,
      workspaceRoot,
    });
  }
  for (const [nodeId, artifacts] of Object.entries(input.artifacts ?? {})) {
    for (const [name, content] of Object.entries(artifacts)) {
      await writeNodeArtifact({
        content,
        name,
        nodeId,
        runId: input.runId,
        workspaceRoot,
      });
    }
  }
};

const snapshotFiles = (root: string, current: string): FileSnapshot => {
  const snapshot: FileSnapshot = {};
  for (const entry of readdirSync(current).toSorted()) {
    const fullPath = join(current, entry);
    if (statSync(fullPath).isDirectory()) {
      Object.assign(snapshot, snapshotFiles(root, fullPath));
      continue;
    }
    snapshot[relative(root, fullPath).split(sep).join("/")] = readFileSync(fullPath, "utf-8");
  }
  return snapshot;
};

const snapshotRunState = (workspaceRoot: string): FileSnapshot => {
  const runsRoot = join(workspaceRoot, ".pipeline", "runs");
  if (!existsSync(runsRoot)) {
    return {};
  }
  return snapshotFiles(runsRoot, runsRoot);
};

describe("moka run-control CLI commands", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "moka-run-control-cli-"));
    // Hermetic db.url resolution: point HOME at the (config-less) temp workspace
    // so loadMokaDbUrl never reads the dev machine's real ~/.config/moka, keeping
    // these run-control command tests on the filesystem store regardless of local
    // config state.
    process.env.HOME = workspaceRoot;
    runtimeState.runtimeCalls.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
    restoreEnv("HOME", ORIGINAL_HOME);
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("runs lists known runs newest-first without starting runtime work", async () => {
    await seedRun(workspaceRoot, {
      nodeStatuses: { writer: "passed" },
      runId: "run-20260617100100",
      status: "passed",
    });
    await seedRun(workspaceRoot, {
      nodeStatuses: { writer: "running" },
      runId: "run-20260617101500",
      status: "running",
    });

    const before = snapshotRunState(workspaceRoot);
    const capture = await runMokaInTarget(workspaceRoot, ["runs"]);

    expect(capture.thrown).toBeUndefined();
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(snapshotRunState(workspaceRoot)).toEqual(before);
    expect(capture.stdout).toContain("run-20260617101500");
    expect(capture.stdout).toContain("run-20260617100100");
    expect(capture.stdout).toContain("running");
    expect(capture.stdout).toContain("passed");
    expect(capture.stdout.indexOf("run-20260617101500")).toBeLessThan(capture.stdout.indexOf("run-20260617100100"));
  });

  it("status with no run id targets the latest active run", async () => {
    await seedRun(workspaceRoot, {
      nodeStatuses: { writer: "running" },
      runId: "run-20260617110000",
      status: "running",
    });
    await seedRun(workspaceRoot, {
      nodeStatuses: { writer: "passed" },
      runId: "run-20260617120000",
      status: "passed",
    });

    const before = snapshotRunState(workspaceRoot);
    const capture = await runMokaInTarget(workspaceRoot, ["status"]);

    expect(capture.thrown).toBeUndefined();
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(snapshotRunState(workspaceRoot)).toEqual(before);
    expect(capture.stdout).toContain("run-20260617110000");
    expect(capture.stdout).toContain("running");
    expect(capture.stdout).not.toContain("run-20260617120000");
  });

  it("status with no run id reports multiple active runs clearly", async () => {
    await seedRun(workspaceRoot, {
      nodeStatuses: { writer: "running" },
      runId: "run-20260617130000",
      status: "running",
    });
    await seedRun(workspaceRoot, {
      nodeStatuses: { verifier: "starting" },
      runId: "run-20260617131500",
      status: "starting",
    });

    const before = snapshotRunState(workspaceRoot);
    const capture = await runMokaInTarget(workspaceRoot, ["status"]);
    const reported = [capture.stdout, capture.stderr, String(capture.thrown)].join("\n");

    expect(snapshotRunState(workspaceRoot)).toEqual(before);
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(reported).toMatch(MULTIPLE_ACTIVE_RUNS_RE);
    expect(reported).toContain("run-20260617130000");
    expect(reported).toContain("run-20260617131500");
  });

  it("status --json returns machine-readable status for the requested run", async () => {
    await seedRun(workspaceRoot, {
      nodeStatuses: { planner: "passed", writer: "running" },
      runId: "run-20260617140000",
      status: "running",
    });

    const before = snapshotRunState(workspaceRoot);
    const capture = await runMokaInTarget(workspaceRoot, ["status", "run-20260617140000", "--json"]);

    expect(capture.thrown).toBeUndefined();
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(snapshotRunState(workspaceRoot)).toEqual(before);

    const status = JSON.parse(capture.stdout) as {
      active: boolean;
      events: unknown[];
      nodes: Record<string, string>;
      runId: string;
      status: string;
    };
    expect(status).toMatchObject({
      active: true,
      nodes: { planner: "passed", writer: "running" },
      runId: "run-20260617140000",
      status: "running",
    });
    expect(Array.isArray(status.events)).toBe(true);
  });

  it("logs tails whole-run and node-specific artifacts without mutating run state", async () => {
    await seedRun(workspaceRoot, {
      artifacts: {
        planner: { "stdout.log": "planner boot\nplanner final line\n" },
        writer: { "stdout.log": "writer boot\nwriter final line\n" },
      },
      nodeStatuses: { planner: "passed", writer: "passed" },
      runId: "run-20260617150000",
      status: "passed",
    });

    const before = snapshotRunState(workspaceRoot);
    const wholeRun = await runMokaInTarget(workspaceRoot, ["logs", "run-20260617150000"]);
    const writerOnly = await runMokaInTarget(workspaceRoot, ["logs", "run-20260617150000", "writer"]);

    expect(wholeRun.thrown).toBeUndefined();
    expect(writerOnly.thrown).toBeUndefined();
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(snapshotRunState(workspaceRoot)).toEqual(before);
    expect(wholeRun.stdout).toContain("planner final line");
    expect(wholeRun.stdout).toContain("writer final line");
    expect(writerOnly.stdout).toContain("writer final line");
    expect(writerOnly.stdout).not.toContain("planner final line");
  });

  it("stop can abort a single node without aborting sibling work", async () => {
    await seedRun(workspaceRoot, {
      nodeStatuses: { planner: "running", writer: "running" },
      runId: "run-20260617160000",
      status: "running",
    });

    const capture = await runMokaInTarget(workspaceRoot, ["stop", "run-20260617160000", "writer"]);

    expect(capture.thrown).toBeUndefined();
    expect(capture.stdout).toContain("run-20260617160000");
    expect(capture.stdout).toContain("writer");
    expect(capture.stdout).toContain("aborted");

    const stoppedRun = await readRun({
      runId: "run-20260617160000",
      workspaceRoot,
    });
    expect(stoppedRun).toMatchObject({
      nodes: { planner: "running", writer: "aborted" },
      status: "running",
    });
  });

  it("export --sanitize emits a portable evidence bundle without prompt or session body text", async () => {
    await seedRun(workspaceRoot, {
      artifacts: {
        writer: {
          "prompt.txt": `user prompt ${PROMPT_SESSION_SECRET}\n`,
          "session-body.json": JSON.stringify({ body: PROMPT_SESSION_SECRET }),
          "verification.log": "node final evidence\n",
        },
      },
      nodeStatuses: { writer: "passed" },
      runId: "run-20260617170000",
      status: "passed",
    });

    const before = snapshotRunState(workspaceRoot);
    const capture = await runMokaInTarget(workspaceRoot, ["export", "run-20260617170000", "--sanitize"]);

    expect(capture.thrown).toBeUndefined();
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(snapshotRunState(workspaceRoot)).toEqual(before);

    const bundle = JSON.parse(capture.stdout) as {
      artifacts: { content?: string; name: string; nodeId: string }[];
      run: { runId: string; status: string };
      version: number;
    };
    expect(bundle).toMatchObject({
      run: { runId: "run-20260617170000", status: "passed" },
      version: 1,
    });
    expect(bundle.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("node final evidence"),
          name: "verification.log",
          nodeId: "writer",
        }),
      ]),
    );
    expect(JSON.stringify(bundle)).not.toContain(PROMPT_SESSION_SECRET);
  });

  it("read commands do not start runtime work or mutate run state", async () => {
    await seedRun(workspaceRoot, {
      artifacts: {
        writer: { "stdout.log": "read command evidence\n" },
      },
      nodeStatuses: { writer: "running" },
      runId: "run-20260617180000",
      status: "running",
    });

    const before = snapshotRunState(workspaceRoot);
    const captures: CliCapture[] = [];
    captures.push(await runMokaInTarget(workspaceRoot, ["runs"]));
    captures.push(await runMokaInTarget(workspaceRoot, ["status", "run-20260617180000"]));
    captures.push(await runMokaInTarget(workspaceRoot, ["logs", "run-20260617180000", "writer"]));
    captures.push(await runMokaInTarget(workspaceRoot, ["export", "run-20260617180000", "--sanitize"]));

    expect(captures.map((capture) => capture.thrown)).toEqual([undefined, undefined, undefined, undefined]);
    expect(runtimeState.runtimeCalls).toEqual([]);
    expect(snapshotRunState(workspaceRoot)).toEqual(before);
  });
});
