import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("@mastra/core/workflows", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mastra/core/workflows")>();
  return { ...real };
});

import { execa } from "execa";

const mockExeca = vi.mocked(execa);
const DESCRIPTION_RE = /description/i;

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("findReadyPhase", () => {
  it("returns null when no unblocked To Do tasks exist", async () => {
    const { findReadyPhase } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ tasks: [] }),
      exitCode: 0,
    } as any);

    const result = await findReadyPhase("PIPE-99");
    expect(result).toBeNull();
  });

  it("returns the first unblocked task id", async () => {
    const { findReadyPhase } = await import("../src/mastra/backlog.js");

    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({
        tasks: [
          { id: "PIPE-99-R", status: "To Do", dependencies: [] },
          { id: "PIPE-99-TW", status: "To Do", dependencies: ["PIPE-99-R"] },
        ],
      }),
      exitCode: 0,
    } as any);

    const result = await findReadyPhase("PIPE-99");
    expect(result).toBe("PIPE-99-R");
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
});
