import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Stub the resolver so runner tests don't depend on a real config file.
vi.mock("../src/mastra/config.ts", () => ({
  // Identity-ish: every role resolves to a fixed profile name we can assert on.
  resolveProfileForPhase: (
    role: "researcher" | "test-writer" | "code-writer" | "verifier"
  ) =>
    ({
      researcher: "researcher",
      "test-writer": "test-writer-profile",
      "code-writer": "code-writer-profile",
      verifier: "verifier",
    })[role],
  parseTicketAndDescription: (s: string) => ({
    ticketId: null,
    description: s,
  }),
  loadPipelineConfig: () => ({ phases: {} }),
  readTicketOverride: () => null,
  BUILT_IN_CONFIG: { phases: {} },
}));

import { execa } from "execa";
import { spawnAgent } from "../src/mastra/runner.ts";

const mockExeca = vi.mocked(execa);

function makeSimpleResult(stdout = "output", exitCode = 0) {
  return Promise.resolve({ stdout, exitCode }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Each test asserts: execa is called with PROFILE name (resolved from role),
// followed by [harness, ...harness-argv].
// ---------------------------------------------------------------------------

describe("spawnAgent — claude harness", () => {
  it("invokes <profile> claude --print -p <prompt> (no contextFile)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("claude output", 0));

    const result = await spawnAgent(
      "claude",
      "researcher",
      "do the thing",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "researcher", // resolved profile
      ["claude", "--print", "-p", "do the thing"],
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
    expect(result).toEqual({ stdout: "claude output", exitCode: 0 });
  });

  it("prepends loaded context when contextFile is provided (claude argv)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("ok", 0));

    // Use a fake fs read by writing a temp file.
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const ctx = join(dir, "ctx.md");
    writeFileSync(ctx, "CONTEXT");

    try {
      await spawnAgent("claude", "researcher", "write code", ctx, "/tmp/wt");
      const args = mockExeca.mock.calls[0][1] as string[];
      const promptIdx = args.indexOf("-p") + 1;
      expect(args[promptIdx]).toBe("CONTEXT\nwrite code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnAgent — codex harness", () => {
  it("invokes <profile> codex exec --json --sandbox workspace-write --skip-git-repo-check <prompt> -C <worktree>", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("codex output", 0));

    const result = await spawnAgent(
      "codex",
      "test-writer",
      "write tests",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "test-writer-profile",
      [
        "codex",
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "write tests",
        "-C",
        "/tmp/wt",
      ],
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
    expect(result).toEqual({ stdout: "codex output", exitCode: 0 });
  });
});

describe("spawnAgent — opencode harness", () => {
  it("invokes <profile> opencode run --format json --dir <worktree> <prompt> (no contextFile)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));

    await spawnAgent("opencode", "verifier", "verify things", null, "/tmp/wt");

    expect(mockExeca).toHaveBeenCalledWith(
      "verifier",
      [
        "opencode",
        "run",
        "--format",
        "json",
        "--dir",
        "/tmp/wt",
        "verify things",
      ],
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
  });

  it("appends --file <contextFile> when provided", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));

    await spawnAgent(
      "opencode",
      "verifier",
      "verify things",
      "/tmp/ctx.md",
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "verifier",
      [
        "opencode",
        "run",
        "--format",
        "json",
        "--dir",
        "/tmp/wt",
        "verify things",
        "--file",
        "/tmp/ctx.md",
      ],
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
  });
});

describe("spawnAgent — pi harness", () => {
  it("invokes <profile> pi --mode rpc --no-session with stdin:pipe; sends JSONL; reads until agent_end", async () => {
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
      "researcher",
      ["pi", "--mode", "rpc", "--no-session"],
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
