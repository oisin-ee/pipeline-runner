import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreEnv, runMokaCliInTarget } from "./run-control-test-helpers";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;
const DB_URL_REQUIRED_RE = /db\.url-required.*momokaya\.db\.url/u;

const mockState = vi.hoisted(() => ({
  runtimeCalls: 0,
  scheduleCalls: 0,
}));

vi.mock("../src/pipeline-runtime", () => ({
  runPipelineFromConfig: vi.fn(async () => {
    mockState.runtimeCalls += 1;
    return {
      agentInvocations: [],
      failureDetails: [],
      gates: [],
      hookFailures: [],
      nodes: [],
      outcome: "PASS",
      plan: {
        parallelBatches: [],
        topologicalOrder: [],
        workflowId: "execute",
      },
    };
  }),
}));

vi.mock("../src/planning/generate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/planning/generate")>();

  return {
    ...actual,
    generateScheduleArtifactInMemory: vi.fn(async () => {
      mockState.scheduleCalls += 1;
      return {
        yaml: [
          "version: 1",
          "kind: pipeline-schedule",
          "schedule_id: db-required-run",
          "source_entrypoint: execute",
          "task: Ship scheduled",
          "generated_at: 2026-06-17T00:00:00.000Z",
          "root_workflow: root",
          "workflows:",
          "  root:",
          "    nodes:",
          "      - id: scheduled",
          "        kind: command",
          "        command: [node, -e, \"console.log('scheduled')\"]",
          "",
        ].join("\n"),
      };
    }),
  };
});

describe("moka run required DB URL", () => {
  let homeDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "moka-run-db-required-home-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "moka-run-db-required-"));
    process.env.HOME = homeDir;
    mockState.runtimeCalls = 0;
    mockState.scheduleCalls = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv("HOME", ORIGINAL_HOME);
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
    rmSync(homeDir, { force: true, recursive: true });
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("fails scheduled local runs before creating .pipeline when momokaya.db.url is absent (AC1)", async () => {
    const capture = await runMokaCliInTarget({
      args: ["run", "--effort", "thorough", "Ship", "scheduled"],
      buffers: { stderr: [], stdout: [] },
      originalPipelineTargetPath: ORIGINAL_PIPELINE_TARGET_PATH,
      workspaceRoot,
    });

    expect(capture.thrown).toBeInstanceOf(Error);
    expect(String(capture.thrown)).toMatch(DB_URL_REQUIRED_RE);
    expect(mockState.scheduleCalls).toBe(1);
    expect(mockState.runtimeCalls).toBe(0);
    expect(existsSync(join(workspaceRoot, ".pipeline"))).toBe(false);
  });
});
