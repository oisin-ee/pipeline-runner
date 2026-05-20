import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { spawnAgent } from "../src/mastra/runner.ts";

const mockExeca = vi.mocked(execa);

/** Build a resolved subprocess mock for harnesses that just await the result */
function makeSimpleResult(stdout = "output", exitCode = 0) {
  return Promise.resolve({ stdout, exitCode }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------
describe("spawnAgent — claude harness", () => {
  it("spawns claude with --print -p prompt --cwd worktreePath (no contextFile)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("claude output", 0));

    const result = await spawnAgent(
      "claude",
      "researcher",
      "do the thing",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith("claude", [
      "--print",
      "-p",
      "do the thing",
      "--cwd",
      "/tmp/wt",
    ]);
    expect(result).toEqual({ stdout: "claude output", exitCode: 0 });
  });

  it("passes plain prompt unchanged when no contextFile", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("ok", 0));
    await spawnAgent("claude", "code-writer", "write code", null, "/tmp/wt");
    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-p") + 1]).toBe("write code");
  });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------
describe("spawnAgent — codex harness", () => {
  it("spawns codex exec --json prompt -C worktreePath with empty stdin when no contextFile", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("codex output", 0));

    const result = await spawnAgent(
      "codex",
      "test-writer",
      "write tests",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "codex",
      ["exec", "--json", "write tests", "-C", "/tmp/wt"],
      expect.objectContaining({ input: "" })
    );
    expect(result).toEqual({ stdout: "codex output", exitCode: 0 });
  });
});

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------
describe("spawnAgent — opencode harness", () => {
  it("spawns opencode run --format json --dir worktreePath prompt (no contextFile)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));

    const result = await spawnAgent(
      "opencode",
      "verifier",
      "verify things",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith("opencode", [
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/wt",
      "verify things",
    ]);
    expect(result).toEqual({ stdout: "opencode output", exitCode: 0 });
  });

  it("appends --file contextFile when contextFile provided", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));

    await spawnAgent(
      "opencode",
      "verifier",
      "verify things",
      "/tmp/ctx.md",
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith("opencode", [
      "run",
      "--format",
      "json",
      "--dir",
      "/tmp/wt",
      "verify things",
      "--file",
      "/tmp/ctx.md",
    ]);
  });
});

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------
describe("spawnAgent — pi harness", () => {
  it("spawns pi --mode rpc --no-session with cwd and stdin:pipe, sends JSONL, reads until agent_end", async () => {
    const stdoutLines = [
      '{"type":"thinking","message":"ok"}',
      '{"type":"agent_end","result":"done"}',
    ];

    function* makeAsyncIter() {
      for (const line of stdoutLines) {
        yield line;
      }
    }

    const stdinMock = { write: vi.fn(), end: vi.fn() };

    // The subprocess is both a promise (resolves to { exitCode }) and has .stdout / .stdin
    const subprocess: any = Object.assign(Promise.resolve({ exitCode: 0 }), {
      stdin: stdinMock,
      stdout: makeAsyncIter(),
    });

    mockExeca.mockReturnValue(subprocess);

    const result = await spawnAgent(
      "pi",
      "researcher",
      "research this",
      "/tmp/ctx.md",
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "pi",
      ["--mode", "rpc", "--no-session"],
      expect.objectContaining({ cwd: "/tmp/wt", stdin: "pipe" })
    );

    const writeCalls = stdinMock.write.mock.calls.map((c: any) => c[0]);
    expect(writeCalls[0]).toContain('"type":"bash"');
    expect(writeCalls[0]).toContain("cat /tmp/ctx.md");
    expect(writeCalls[1]).toContain('"type":"prompt"');
    expect(writeCalls[1]).toContain("research this");

    expect(result.stdout).toContain("agent_end");
    expect(result.exitCode).toBe(0);
  });
});
