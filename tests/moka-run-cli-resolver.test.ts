import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RuntimeCall {
  entrypoint?: string;
  task: string;
  workflowId?: string;
  worktreePath: string;
}

interface ScheduleCall {
  entrypointId: string;
  task: string;
  worktreePath: string;
}

interface SubmitCall {
  flags: Record<string, unknown>;
  input: string[];
}

const mockState = vi.hoisted(() => ({
  runtimeCalls: [] as RuntimeCall[],
  scheduleCalls: [] as ScheduleCall[],
  submitCalls: [] as SubmitCall[],
}));

vi.mock("../src/pipeline-runtime", () => ({
  runPipelineFromConfig: vi.fn((input: RuntimeCall) => {
    mockState.runtimeCalls.push(input);
    return Promise.resolve({
      agentInvocations: [],
      failureDetails: [],
      gates: [],
      hookFailures: [],
      nodes: [],
      outcome: "PASS",
      plan: {
        parallelBatches: [],
        topologicalOrder: [],
        workflowId: input.workflowId ?? input.entrypoint ?? "resolved-workflow",
      },
    });
  }),
}));

vi.mock("../src/planning/generate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/planning/generate")>();
  const fs = await import("node:fs");
  const path = await import("node:path");

  return {
    ...actual,
    generateScheduleArtifact: vi.fn(
      (input: ScheduleCall & { runId: string }) => {
        mockState.scheduleCalls.push(input);
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
            "root_workflow: root",
            "workflows:",
            "  root:",
            "    nodes:",
            "      - id: scheduled",
            "        kind: command",
            "        command: [node, -e, \"console.log('scheduled')\"]",
            "",
          ].join("\n")
        );
        return Promise.resolve({ path: schedulePath });
      }
    ),
  };
});

vi.mock("../src/cli/submit-options", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/cli/submit-options")>();
  return {
    ...actual,
    runMokaSubmitFromCli: vi.fn(
      (input: string[], flags: Record<string, unknown>) => {
        mockState.submitCalls.push({ flags, input });
        return Promise.resolve({
          namespace: "test-runners",
          workflowName: "submitted-run",
        });
      }
    ),
  };
});

const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;

beforeEach(() => {
  mockState.runtimeCalls.length = 0;
  mockState.scheduleCalls.length = 0;
  mockState.submitCalls.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_PIPELINE_TARGET_PATH === undefined) {
    delete process.env.PIPELINE_TARGET_PATH;
  } else {
    process.env.PIPELINE_TARGET_PATH = ORIGINAL_PIPELINE_TARGET_PATH;
  }
});

async function withCliTarget(
  run: (input: {
    dir: string;
    parseRun: (args: string[]) => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "moka-run-resolver-cli-"));
  process.env.PIPELINE_TARGET_PATH = dir;
  try {
    const { createCliProgram } = await import("../src/cli/program");
    const parseRun = async (args: string[]) => {
      await createCliProgram().parseAsync(
        ["node", "/repo/node_modules/.bin/moka", "run", ...args],
        { from: "node" }
      );
    };
    await run({ dir, parseRun });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function writeSchedule(root: string, relativePath: string): string {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    [
      "version: 1",
      "kind: pipeline-schedule",
      "schedule_id: approved-run",
      "source_entrypoint: execute",
      "task: Use approved schedule",
      "generated_at: 2026-06-17T00:00:00.000Z",
      "root_workflow: root",
      "workflows:",
      "  root:",
      "    nodes:",
      "      - id: scheduled",
      "        kind: command",
      "        command: [node, -e, \"console.log('approved')\"]",
      "",
    ].join("\n")
  );
  return fullPath;
}

describe("moka run CLI flag resolver wiring", () => {
  it("routes --read-only to the local inspect workflow without schedule generation", async () => {
    await withCliTarget(async ({ parseRun }) => {
      await parseRun(["--read-only", "Inspect", "the", "repo"]);

      expect(mockState.submitCalls).toEqual([]);
      expect(mockState.scheduleCalls).toEqual([]);
      expect(mockState.runtimeCalls).toHaveLength(1);
      expect(mockState.runtimeCalls[0]).toMatchObject({
        task: "Inspect the repo",
        workflowId: "inspect",
      });
    });
  });

  it.each([
    ["quick", "quick"],
    ["thorough", "execute"],
  ] as const)("routes --effort %s to the %s scheduled entrypoint locally", async (effort, entrypointId) => {
    await withCliTarget(async ({ parseRun }) => {
      await parseRun(["--effort", effort, "Ship", "it"]);

      expect(mockState.submitCalls).toEqual([]);
      expect(mockState.scheduleCalls).toHaveLength(1);
      expect(mockState.scheduleCalls[0]).toMatchObject({
        entrypointId,
        task: "Ship it",
      });
      expect(mockState.runtimeCalls).toHaveLength(1);
    });
  });

  it("lets --workflow override effort routing for advanced local runs", async () => {
    await withCliTarget(async ({ parseRun }) => {
      await parseRun([
        "--effort",
        "quick",
        "--workflow",
        "inspect",
        "Inspect",
        "only",
      ]);

      expect(mockState.submitCalls).toEqual([]);
      expect(mockState.scheduleCalls).toEqual([]);
      expect(mockState.runtimeCalls).toHaveLength(1);
      expect(mockState.runtimeCalls[0]).toMatchObject({
        task: "Inspect only",
        workflowId: "inspect",
      });
    });
  });

  it("keeps --schedule on the local approved schedule execution path", async () => {
    await withCliTarget(async ({ dir, parseRun }) => {
      const schedulePath = writeSchedule(dir, "approved/schedule.yaml");

      await parseRun(["--schedule", schedulePath, "Use", "approved"]);

      expect(readFileSync(schedulePath, "utf8")).toContain(
        "schedule_id: approved-run"
      );
      expect(mockState.submitCalls).toEqual([]);
      expect(mockState.scheduleCalls).toEqual([]);
      expect(mockState.runtimeCalls).toHaveLength(1);
      expect(mockState.runtimeCalls[0]).toMatchObject({
        task: "Use approved",
        workflowId: "schedule-approved-run-root",
      });
    });
  });

  it("routes --target remote through the existing submit path instead of local runtime", async () => {
    await withCliTarget(async ({ parseRun }) => {
      await parseRun([
        "--target",
        "remote",
        "--effort",
        "quick",
        "Ship",
        "remote",
      ]);

      expect(mockState.runtimeCalls).toEqual([]);
      expect(mockState.scheduleCalls).toEqual([]);
      expect(mockState.submitCalls).toHaveLength(1);
      expect(mockState.submitCalls[0]).toMatchObject({
        input: ["Ship", "remote"],
      });
      expect(mockState.submitCalls[0].flags).toMatchObject({ quick: true });
    });
  });
});
