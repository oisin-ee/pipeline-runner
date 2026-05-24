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
    expect(result).toEqual(
      expect.objectContaining({ stdout: "claude output", exitCode: 0 })
    );
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
  it("invokes <profile> codex exec with noninteractive write/approval flags", async () => {
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
        "--config",
        'approval_policy="never"',
        "--skip-git-repo-check",
        "write tests",
        "-C",
        "/tmp/wt",
      ],
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
    );
    expect(result).toEqual(
      expect.objectContaining({ stdout: "codex output", exitCode: 0 })
    );
  });

  it("returns timeout diagnostics instead of losing subprocess evidence", async () => {
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("timed out"), {
        exitCode: undefined,
        stdout: "partial output",
        stderr: "permission prompt",
        timedOut: true,
      })
    );

    const result = await spawnAgent(
      "codex",
      "test-writer",
      "write tests",
      null,
      "/tmp/wt"
    );

    expect(result).toEqual(
      expect.objectContaining({
        exitCode: 1,
        stderr: "permission prompt",
        stdout: "partial output",
        timedOut: true,
      })
    );
    expect(result.argv).toContain('approval_policy="never"');
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
        "--model",
        "opencode/deepseek-v4-flash-free",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "verify things",
      ],
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
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
        "--model",
        "opencode/deepseek-v4-flash-free",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "verify things",
        "--file",
        "/tmp/ctx.md",
      ],
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
    );
  });

  it("adds git info excludes before opencode runs", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));
    const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await import("node:fs").then(({ mkdtempSync }) =>
      mkdtempSync(join(tmpdir(), "runner-opencode-"))
    );

    try {
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      writeFileSync(join(dir, ".git", "info", "exclude"), "# existing\n");

      await spawnAgent("opencode", "verifier", "verify things", null, dir);

      const exclude = readFileSync(join(dir, ".git", "info", "exclude"), {
        encoding: "utf8",
      });
      expect(exclude).toContain("node_modules/");
      expect(exclude).toContain(".opencode/node_modules/");
      expect(exclude).toContain(".mastra/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnAgent — pi harness", () => {
  it("invokes <profile> pi --print --mode json --no-session with context in prompt", async () => {
    mockExeca.mockReturnValue(makeSimpleResult('{"type":"agent_end"}', 0));
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const ctx = join(dir, "ctx.md");
    writeFileSync(ctx, "CONTEXT");

    try {
      const result = await spawnAgent(
        "pi",
        "researcher",
        "research this",
        ctx,
        "/tmp/wt"
      );

      expect(mockExeca).toHaveBeenCalledWith(
        "researcher",
        [
          "pi",
          "--print",
          "--mode",
          "json",
          "--no-session",
          "CONTEXT\nresearch this",
        ],
        expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
      );

      expect(result.stdout).toContain("agent_end");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
