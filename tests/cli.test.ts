import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const PIPE_42_RE = /PIPE-42/;
const PHASE_FLOW_RE = /research → RED → GREEN → VERIFY → LEARN/;
const UNSUPPORTED_HARNESS_RE = /Unsupported --harness "bogus"|allowed choices/;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockResolvedValue({ start: mockRunStart });
  mockGetWorkflow.mockReturnValue({ createRun: mockCreateRun });
});

afterEach(() => {
  vi.restoreAllMocks();
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

function backlogCreateOutput(id: string, title: string): string {
  return `File: /tmp/wt/backlog/tasks/${id.toLowerCase()} - slug.md\n\nTask ${id} - ${title}\n==================================================\n`;
}

describe("createSwarmTasks", () => {
  it("creates parent + 5 child tasks via backlog and returns the assigned id map", async () => {
    const { createSwarmTasks } = await import("../src/mastra/backlog.js");

    // Sequence of backlog task create stdouts: parent, then R, TW, CW, V, L children
    mockExeca
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10", "pipe task"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.1", "research"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.2", "test-write"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.3", "implement"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.4", "verify"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.5", "learn"),
        exitCode: 0,
      } as any);

    const swarm = await createSwarmTasks("pipe task", "/tmp/wt");

    expect(swarm).toEqual({
      parentId: "TASK-10",
      phases: {
        R: "TASK-10.1",
        TW: "TASK-10.2",
        CW: "TASK-10.3",
        V: "TASK-10.4",
        L: "TASK-10.5",
      },
    });
    // 6 calls total: 1 parent + 5 children
    const createCalls = mockExeca.mock.calls.filter((c) => {
      const args = c[1] as string[] | undefined;
      return (
        c[0] === "backlog" && args?.[0] === "task" && args?.[1] === "create"
      );
    });
    expect(createCalls.length).toBe(6);
  });

  it("threads worktree path as cwd into every backlog invocation", async () => {
    const { createSwarmTasks } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({
      stdout: backlogCreateOutput("TASK-1", "x"),
      exitCode: 0,
    } as any);

    await createSwarmTasks("x", "/some/wt");

    for (const call of mockExeca.mock.calls) {
      if (call[0] === "backlog") {
        expect(
          (call as unknown as [string, string[], { cwd: string }])[2]
        ).toMatchObject({ cwd: "/some/wt" });
      }
    }
  });

  it("accepts custom Backlog task prefixes from real CLI output", async () => {
    const { createSwarmTasks } = await import("../src/mastra/backlog.js");

    mockExeca
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("PIPE-1", "pipe task"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("PIPE-1.1", "research"),
        exitCode: 0,
      } as any)
      .mockResolvedValue({
        stdout: backlogCreateOutput("PIPE-1.2", "phase"),
        exitCode: 0,
      } as any);

    const swarm = await createSwarmTasks("pipe task", "/tmp/wt");

    expect(swarm.parentId).toBe("PIPE-1");
    expect(swarm.phases.R).toBe("PIPE-1.1");
  });

  it("does not append --no-git to backlog calls (init-only flag in upstream)", async () => {
    const { createSwarmTasks } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({
      stdout: backlogCreateOutput("TASK-1", "x"),
      exitCode: 0,
    } as any);

    await createSwarmTasks("PIPE-42", "/tmp/wt");

    for (const call of mockExeca.mock.calls) {
      if (call[0] === "backlog") {
        expect(call[1]).not.toContain("--no-git");
      }
    }
  });
});

describe("markPhase", () => {
  it("calls backlog task edit with --status against the assigned id", async () => {
    const { markPhase } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);

    await markPhase("TASK-10.1", "Done", "/tmp/wt");

    expect(mockExeca).toHaveBeenCalledWith(
      "backlog",
      expect.arrayContaining(["task", "edit", "TASK-10.1", "--status", "Done"]),
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
  });
});

describe("planPhaseLifecycle", () => {
  const SWARM = {
    parentId: "TASK-99",
    phases: {
      R: "TASK-99.1",
      TW: "TASK-99.2",
      CW: "TASK-99.3",
      V: "TASK-99.4",
      L: "TASK-99.5",
    },
  } as const;

  it("plans each phase In Progress then Done for a successful run", async () => {
    const { planPhaseLifecycle } = await import("../src/mastra/backlog.js");

    const result = planPhaseLifecycle(SWARM, {
      outcome: "PASS",
      failureDetails: [],
    });

    expect(result.statusUpdates).toEqual([
      { taskId: "TASK-99.1", status: "In Progress" },
      { taskId: "TASK-99.1", status: "Done" },
      { taskId: "TASK-99.2", status: "In Progress" },
      { taskId: "TASK-99.2", status: "Done" },
      { taskId: "TASK-99.3", status: "In Progress" },
      { taskId: "TASK-99.3", status: "Done" },
      { taskId: "TASK-99.4", status: "In Progress" },
      { taskId: "TASK-99.4", status: "Done" },
      { taskId: "TASK-99.5", status: "In Progress" },
      { taskId: "TASK-99.5", status: "Done" },
    ]);
    expect(result.failureNote).toBeUndefined();
  });

  it("stops at the gate failure phase and records failure context", async () => {
    const { planPhaseLifecycle } = await import("../src/mastra/backlog.js");

    const result = planPhaseLifecycle(SWARM, {
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
      { taskId: "TASK-99.1", status: "In Progress" },
      { taskId: "TASK-99.1", status: "Done" },
      { taskId: "TASK-99.2", status: "In Progress" },
      { taskId: "TASK-99.2", status: "Done" },
      { taskId: "TASK-99.3", status: "In Progress" },
    ]);
    expect(result.failureNote).toEqual({
      taskId: "TASK-99.3",
      note: "GREEN gate failed: tests failed\n\nEvidence:\n- expected 2 received 1",
    });
  });
});

// ─── CLI entry ────────────────────────────────────────────────────────────────

describe("pipe", () => {
  it("exports a pipe function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.pipe).toBe("function");
  });

  it("uses Commander for package and direct pipe CLI invocations", async () => {
    const { runCli } = await import("../src/index.js");

    vi.spyOn(Date, "now").mockReturnValue(123);
    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);

    await expect(
      runCli([
        "node",
        "/repo/dist/index.js",
        "pipe",
        "ship it",
        "--strict",
        "--harness",
        "bogus",
      ])
    ).rejects.toThrow(UNSUPPORTED_HARNESS_RE);
    await expect(
      runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "ship it",
        "--strict",
        "--harness",
        "bogus",
      ])
    ).rejects.toThrow(UNSUPPORTED_HARNESS_RE);
  });

  it("supports direct pipe init invocation from the pipe binary", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-init-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

      expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(true);
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares installable binaries and typed subpath exports", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as {
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
    };

    expect(pkg).toMatchObject({
      name: "@oisincoveney/pipeline",
      publishConfig: { access: "public" },
    });
    expect(pkg.bin).toEqual({
      "oisin-pipeline": "dist/index.js",
      pipe: "dist/index.js",
    });
    expect(pkg.exports?.["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./pipeline-primitive"]).toEqual({
      import: "./dist/mastra/pipeline-primitive.js",
      types: "./dist/mastra/pipeline-primitive.d.ts",
    });
    expect(pkg.exports?.["./runner"]).toEqual({
      import: "./dist/mastra/runner.js",
      types: "./dist/mastra/runner.d.ts",
    });
  });

  it("throws if no description provided", async () => {
    const { pipe } = await import("../src/index.js");
    await expect(pipe("")).rejects.toThrow(DESCRIPTION_RE);
  });

  it("soft mode (default) spawns orchestrator interactively with an initial pipeline-driving prompt", async () => {
    const { pipe } = await import("../src/index.js");

    const spawnInteractive = vi.fn().mockResolvedValue({ exitCode: 0 });

    await pipe("PIPE-42 trivial NOOP", { spawnInteractive });

    expect(spawnInteractive).toHaveBeenCalledTimes(1);
    const call = spawnInteractive.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    const [command, args, opts] = call;
    expect(command).toBe("orchestrator");
    expect(args[0]).toBe("codex");
    expect(args[1]).toMatch(PIPE_42_RE);
    expect(args[1]).toMatch(PHASE_FLOW_RE);
    expect(opts.cwd).toBe(process.cwd());
    // Soft mode does NOT invoke the Mastra runner.
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("strict mode threads ticketId into the pipeline primitive input", async () => {
    const { pipe } = await import("../src/index.js");

    stageBacklogCreates();
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "PASS",
      failureDetails: [],
    });

    await pipe("PIPE-42 trivial NOOP", { pipelineRunner, strict: true });

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "PIPE-42",
        task: "PIPE-42 trivial NOOP",
        harness: "codex",
      })
    );
  });

  it("uses codex as the default harness when --harness is not passed", async () => {
    const { pipe } = await import("../src/index.js");

    stageBacklogCreates();
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "PASS",
      failureDetails: [],
    });

    await pipe("PIPE-7 noop", { pipelineRunner, strict: true });

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "codex" })
    );
  });

  it("threads explicit --harness option through to the runner", async () => {
    const { pipe } = await import("../src/index.js");

    stageBacklogCreates();
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "PASS",
      failureDetails: [],
    });

    await pipe("PIPE-7 noop", {
      pipelineRunner,
      strict: true,
      harness: "claude",
    });

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "claude" })
    );
  });

  it("rejects unsupported --harness values before starting work", async () => {
    const { runCli } = await import("../src/index.js");

    await expect(
      runCli([
        "node",
        "/repo/dist/index.js",
        "pipe",
        "ship it",
        "--harness",
        "bogus",
      ])
    ).rejects.toThrow(UNSUPPORTED_HARNESS_RE);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  /**
   * Stages mockExeca to satisfy `createSwarmTasks`: 6 sequential `backlog task
   * create` calls, returning TASK-99 (parent) then TASK-99.1..TASK-99.5
   * (children). Falls through to a default empty-stdout success for everything
   * after (markPhase, appendPhaseNote).
   */
  function stageBacklogCreates(): void {
    mockExeca
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-99", "ship it"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-99.1", "research"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-99.2", "test-write"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-99.3", "implement"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-99.4", "verify"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-99.5", "learn"),
        exitCode: 0,
      } as any)
      .mockResolvedValue({ stdout: "", exitCode: 0 } as any);
  }

  it("marks every phase In Progress then Done when the pipeline passes", async () => {
    const { pipe } = await import("../src/index.js");

    stageBacklogCreates();
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "PASS",
      failureDetails: [],
    });

    await pipe("ship it", { pipelineRunner, strict: true });

    expect(pipelineRunner).toHaveBeenCalledWith({
      harness: "codex",
      task: "ship it",
      worktreePath: process.cwd(),
      ticketId: null,
    });
    expect(statusUpdates()).toEqual([
      ["TASK-99.1", "In Progress"],
      ["TASK-99.1", "Done"],
      ["TASK-99.2", "In Progress"],
      ["TASK-99.2", "Done"],
      ["TASK-99.3", "In Progress"],
      ["TASK-99.3", "Done"],
      ["TASK-99.4", "In Progress"],
      ["TASK-99.4", "Done"],
      ["TASK-99.5", "In Progress"],
      ["TASK-99.5", "Done"],
    ]);
    expect(noteUpdates()).toEqual([]);
  });

  it.each([
    {
      gate: "RED" as const,
      reason: "tests passed too early",
      evidence: ["All tests passed"],
      failedTask: "TASK-99.2",
      expectedStatuses: [
        ["TASK-99.1", "In Progress"],
        ["TASK-99.1", "Done"],
        ["TASK-99.2", "In Progress"],
      ],
    },
    {
      gate: "GREEN" as const,
      reason: "tests failed",
      evidence: ["expected 2 received 1"],
      failedTask: "TASK-99.3",
      expectedStatuses: [
        ["TASK-99.1", "In Progress"],
        ["TASK-99.1", "Done"],
        ["TASK-99.2", "In Progress"],
        ["TASK-99.2", "Done"],
        ["TASK-99.3", "In Progress"],
      ],
    },
    {
      gate: "VERIFY" as const,
      reason: "verification failed",
      evidence: ["missing edge case"],
      failedTask: "TASK-99.4",
      expectedStatuses: [
        ["TASK-99.1", "In Progress"],
        ["TASK-99.1", "Done"],
        ["TASK-99.2", "In Progress"],
        ["TASK-99.2", "Done"],
        ["TASK-99.3", "In Progress"],
        ["TASK-99.3", "Done"],
        ["TASK-99.4", "In Progress"],
      ],
    },
  ])("keeps later phases To Do and records notes when the $gate gate fails", async ({
    gate,
    reason,
    evidence,
    failedTask,
    expectedStatuses,
  }) => {
    const { pipe } = await import("../src/index.js");

    stageBacklogCreates();
    const pipelineRunner = vi.fn().mockResolvedValue({
      outcome: "FAIL",
      failureDetails: [{ gate, reason, evidence }],
    });

    await pipe("ship it", { pipelineRunner, strict: true });

    expect(statusUpdates()).toEqual(expectedStatuses);
    expect(noteUpdates()).toEqual([
      [
        failedTask,
        `${gate} gate failed: ${reason}\n\nEvidence:\n- ${evidence[0]}`,
      ],
    ]);
    expect(statusUpdates()).not.toContainEqual([failedTask, "Done"]);
    expect(statusUpdates()).not.toContainEqual(["TASK-99.5", "Done"]);
  });
});
