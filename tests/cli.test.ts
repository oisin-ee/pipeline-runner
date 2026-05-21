import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunStart = vi.hoisted(() => vi.fn());
const mockCreateRun = vi.hoisted(() => vi.fn());
const mockGetWorkflow = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../src/mastra/index.js", () => ({
  mastra: {
    getWorkflow: mockGetWorkflow,
  },
}));

vi.mock("@mastra/core/workflows", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mastra/core/workflows")>();
  return { ...real };
});

import { execa } from "execa";

const mockExeca = vi.mocked(execa);
const DESCRIPTION_RE = /description/i;
const ORIGINAL_PIPELINE_HARNESS = process.env.PIPELINE_HARNESS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PIPELINE_HARNESS;
  mockCreateRun.mockResolvedValue({ start: mockRunStart });
  mockGetWorkflow.mockReturnValue({ createRun: mockCreateRun });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_PIPELINE_HARNESS === undefined) {
    delete process.env.PIPELINE_HARNESS;
  } else {
    process.env.PIPELINE_HARNESS = ORIGINAL_PIPELINE_HARNESS;
  }
});

function statusUpdates(): [string, string][] {
  return mockExeca.mock.calls
    .filter(([cmd, args]) => {
      const backlogArgs = args as string[] | undefined;
      return (
        cmd === "backlog" &&
        backlogArgs?.[0] === "task" &&
        backlogArgs?.[1] === "edit" &&
        backlogArgs.includes("--status")
      );
    })
    .map(([, args]) => {
      const backlogArgs = args as string[];
      return [backlogArgs[2], backlogArgs[backlogArgs.indexOf("--status") + 1]];
    });
}

function noteUpdates(): [string, string][] {
  return mockExeca.mock.calls
    .filter(([cmd, args]) => {
      const backlogArgs = args as string[] | undefined;
      return (
        cmd === "backlog" &&
        backlogArgs?.[0] === "task" &&
        backlogArgs?.[1] === "edit" &&
        backlogArgs.includes("--append-notes")
      );
    })
    .map(([, args]) => {
      const backlogArgs = args as string[];
      return [
        backlogArgs[2],
        backlogArgs[backlogArgs.indexOf("--append-notes") + 1],
      ];
    });
}

// ─── backlog.ts ───────────────────────────────────────────────────────────────

describe("createSwarmTasks", () => {
  it("creates 5 swarm tasks (R, TW, CW, V, L) via backlog CLI", async () => {
    const { createSwarmTasks } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);

    await createSwarmTasks("PIPE-99", "/tmp/wt");

    // Should have called backlog task create 5 times
    const createCalls = mockExeca.mock.calls.filter((c) => {
      const args = c[1] as string[] | undefined;
      return (
        c[0] === "backlog" && args?.[0] === "task" && args?.[1] === "create"
      );
    });
    expect(createCalls.length).toBe(5);
  });

  it("passes --no-git flag to all backlog calls", async () => {
    const { createSwarmTasks } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);

    await createSwarmTasks("PIPE-42", "/tmp/wt");

    for (const call of mockExeca.mock.calls) {
      if (call[0] === "backlog") {
        expect(call[1]).toContain("--no-git");
      }
    }
  });
});

describe("markPhase", () => {
  it("calls backlog task edit with --status", async () => {
    const { markPhase } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);

    await markPhase("PIPE-99-R", "Done");

    expect(mockExeca).toHaveBeenCalledWith(
      "backlog",
      expect.arrayContaining([
        "task",
        "edit",
        "PIPE-99-R",
        "--status",
        "Done",
        "--no-git",
      ])
    );
  });
});

describe("planPhaseLifecycle", () => {
  it("plans each phase In Progress then Done for a successful run", async () => {
    const { planPhaseLifecycle } = await import("../src/mastra/backlog.js");

    const result = planPhaseLifecycle("PIPE-99", {
      outcome: "PASS",
      failureDetails: [],
    });

    expect(result.statusUpdates).toEqual([
      { taskId: "PIPE-99-R", status: "In Progress" },
      { taskId: "PIPE-99-R", status: "Done" },
      { taskId: "PIPE-99-TW", status: "In Progress" },
      { taskId: "PIPE-99-TW", status: "Done" },
      { taskId: "PIPE-99-CW", status: "In Progress" },
      { taskId: "PIPE-99-CW", status: "Done" },
      { taskId: "PIPE-99-V", status: "In Progress" },
      { taskId: "PIPE-99-V", status: "Done" },
      { taskId: "PIPE-99-L", status: "In Progress" },
      { taskId: "PIPE-99-L", status: "Done" },
    ]);
    expect(result.failureNote).toBeUndefined();
  });

  it("stops at the gate failure phase and records failure context", async () => {
    const { planPhaseLifecycle } = await import("../src/mastra/backlog.js");

    const result = planPhaseLifecycle("PIPE-99", {
      outcome: "FAIL",
      failureDetails: [
        {
          gate: "GREEN",
          reason: "tests failed",
          evidence: ["expected 2 received 1"],
        },
      ],
    });

    expect(result.statusUpdates).toEqual([
      { taskId: "PIPE-99-R", status: "In Progress" },
      { taskId: "PIPE-99-R", status: "Done" },
      { taskId: "PIPE-99-TW", status: "In Progress" },
      { taskId: "PIPE-99-TW", status: "Done" },
      { taskId: "PIPE-99-CW", status: "In Progress" },
    ]);
    expect(result.failureNote).toEqual({
      taskId: "PIPE-99-CW",
      note: "GREEN gate failed: tests failed\n\nEvidence:\n- expected 2 received 1",
    });
  });
});

// ─── CLI entry ────────────────────────────────────────────────────────────────

describe("workNext", () => {
  it("exports a workNext function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.workNext).toBe("function");
  });

  it("throws if no description provided", async () => {
    const { workNext } = await import("../src/index.js");
    await expect(workNext("")).rejects.toThrow(DESCRIPTION_RE);
  });

  it("rejects unsupported PIPELINE_HARNESS values before starting work", async () => {
    const { workNext } = await import("../src/index.js");

    process.env.PIPELINE_HARNESS = "bogus";

    await expect(workNext("ship it")).rejects.toThrow(
      'Unsupported PIPELINE_HARNESS "bogus". Supported values: claude, codex, opencode, pi.'
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it("marks every phase In Progress then Done when the pipeline passes", async () => {
    const { workNext } = await import("../src/index.js");

    vi.spyOn(Date, "now").mockReturnValue(99);
    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "PASS",
      failureDetails: [],
    });

    await workNext("ship it", { pipelineRunner });

    expect(pipelineRunner).toHaveBeenCalledWith({
      harness: "claude",
      task: "ship it",
      worktreePath: process.cwd(),
    });
    expect(statusUpdates()).toEqual([
      ["TASK-99-R", "In Progress"],
      ["TASK-99-R", "Done"],
      ["TASK-99-TW", "In Progress"],
      ["TASK-99-TW", "Done"],
      ["TASK-99-CW", "In Progress"],
      ["TASK-99-CW", "Done"],
      ["TASK-99-V", "In Progress"],
      ["TASK-99-V", "Done"],
      ["TASK-99-L", "In Progress"],
      ["TASK-99-L", "Done"],
    ]);
    expect(noteUpdates()).toEqual([]);
  });

  it.each([
    {
      gate: "RED" as const,
      reason: "tests passed too early",
      evidence: ["All tests passed"],
      failedTask: "TASK-99-TW",
      expectedStatuses: [
        ["TASK-99-R", "In Progress"],
        ["TASK-99-R", "Done"],
        ["TASK-99-TW", "In Progress"],
      ],
    },
    {
      gate: "GREEN" as const,
      reason: "tests failed",
      evidence: ["expected 2 received 1"],
      failedTask: "TASK-99-CW",
      expectedStatuses: [
        ["TASK-99-R", "In Progress"],
        ["TASK-99-R", "Done"],
        ["TASK-99-TW", "In Progress"],
        ["TASK-99-TW", "Done"],
        ["TASK-99-CW", "In Progress"],
      ],
    },
    {
      gate: "VERIFY" as const,
      reason: "verification failed",
      evidence: ["missing edge case"],
      failedTask: "TASK-99-V",
      expectedStatuses: [
        ["TASK-99-R", "In Progress"],
        ["TASK-99-R", "Done"],
        ["TASK-99-TW", "In Progress"],
        ["TASK-99-TW", "Done"],
        ["TASK-99-CW", "In Progress"],
        ["TASK-99-CW", "Done"],
        ["TASK-99-V", "In Progress"],
      ],
    },
  ])("keeps later phases To Do and records notes when the $gate gate fails", async ({
    gate,
    reason,
    evidence,
    failedTask,
    expectedStatuses,
  }) => {
    const { workNext } = await import("../src/index.js");

    vi.spyOn(Date, "now").mockReturnValue(99);
    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "FAIL",
      failureDetails: [{ gate, reason, evidence }],
    });

    await workNext("ship it", { pipelineRunner });

    expect(statusUpdates()).toEqual(expectedStatuses);
    expect(noteUpdates()).toEqual([
      [
        failedTask,
        `${gate} gate failed: ${reason}\n\nEvidence:\n- ${evidence[0]}`,
      ],
    ]);
    expect(statusUpdates()).not.toContainEqual([failedTask, "Done"]);
    expect(statusUpdates()).not.toContainEqual(["TASK-99-L", "Done"]);
  });
});
