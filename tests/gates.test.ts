import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

let detectMock: ReturnType<typeof vi.fn>;

vi.mock("package-manager-detector/detect", () => ({
  detect: (...args: unknown[]) => detectMock(...args),
}));

import { execa } from "execa";

import {
  artifactExists,
  runFallow,
  runJscpd,
  runSemgrep,
  runTests,
  runTypecheck,
} from "../src/gates";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
detectMock = vi.fn();
const tempDirs: string[] = [];

function tempWorktree(scripts?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-gates-"));
  tempDirs.push(dir);
  if (scripts) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
  }
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  detectMock.mockResolvedValue(null);
  delete process.env.PIPELINE_TEST_COMMAND;
  delete process.env.PIPELINE_TYPECHECK_COMMAND;
  delete process.env.PIPELINE_SEMGREP_COMMAND;
  delete process.env.PIPELINE_FALLOW_COMMAND;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ─── runTests ───────────────────────────────────────────────────────────────

describe("runTests", () => {
  it("returns exitCode 0 and empty failingTests on package test success", async () => {
    const worktree = tempWorktree({ test: "custom-test-runner" });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
    } as any);

    const result = await runTests(worktree);
    expect(result.exitCode).toBe(0);
    expect(result.failingTests).toEqual([]);
    expect(result.output).toContain("All tests passed");
    expect(mockExeca).toHaveBeenCalledWith(
      "npm",
      ["run", "test"],
      expect.objectContaining({ cwd: worktree })
    );
  });

  it("returns exitCode 1 and parses failing test names", async () => {
    const worktree = tempWorktree({ test: "custom-test-runner" });
    const fakeOutput = [
      "✗ should do the thing",
      "FAIL project-test-file",
      "× another failing test",
      " ✓ passing test",
    ].join("\n");
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("exit 1"), {
        exitCode: 1,
        stdout: fakeOutput,
        stderr: "",
      })
    );

    const result = await runTests(worktree);
    expect(result.exitCode).toBe(1);
    expect(result.failingTests).toContain("should do the thing");
    expect(result.failingTests).toContain("another failing test");
    expect(result.failingTests).not.toContain("passing test");
  });

  it("uses explicit PIPELINE_TEST_COMMAND when provided", async () => {
    process.env.PIPELINE_TEST_COMMAND = "make test";
    const worktree = tempWorktree();
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runTests(worktree);

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make test",
      [],
      expect.objectContaining({ cwd: worktree, shell: true })
    );
  });

  it("fails when no test command can be found", async () => {
    const worktree = tempWorktree();

    const result = await runTests(worktree);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No test command found");
    expect(mockExeca).not.toHaveBeenCalled();
  });
});

// ─── runTypecheck ────────────────────────────────────────────────────────────

describe("runTypecheck", () => {
  it("skips if no typecheck command is configured", async () => {
    const worktree = tempWorktree();

    const result = await runTypecheck(worktree);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("skipped");
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("runs package typecheck script when present and returns exit code", async () => {
    const worktree = tempWorktree({ typecheck: "custom-typecheck" });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as any);

    const result = await runTypecheck(worktree);
    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "npm",
      ["run", "typecheck"],
      expect.objectContaining({ cwd: worktree })
    );
  });

  it("runs pnpm package scripts with the real pnpm command", async () => {
    detectMock.mockResolvedValueOnce({ agent: "pnpm" });
    const worktree = tempWorktree({ typecheck: "custom-typecheck" });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runTypecheck(worktree);

    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("pnpm run typecheck");
    expect(mockExeca).toHaveBeenCalledWith(
      "pnpm",
      ["run", "typecheck"],
      expect.objectContaining({ cwd: worktree })
    );
  });

  it("returns exitCode 1 when typecheck command fails", async () => {
    const worktree = tempWorktree({ typecheck: "custom-typecheck" });
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("typecheck error"), {
        exitCode: 1,
        stdout: "typecheck failed",
        stderr: "",
      })
    );

    const result = await runTypecheck(worktree);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("typecheck failed");
  });

  it("uses explicit PIPELINE_TYPECHECK_COMMAND when provided", async () => {
    process.env.PIPELINE_TYPECHECK_COMMAND = "make typecheck";
    const worktree = tempWorktree();
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runTypecheck(worktree);

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make typecheck",
      [],
      expect.objectContaining({ cwd: worktree, shell: true })
    );
  });
});

// ─── runSemgrep ─────────────────────────────────────────────────────────────

describe("runSemgrep", () => {
  it("runs semgrep ci config through uvx against changed files by default", async () => {
    const worktree = tempWorktree();
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src/app.ts"), "export const app = true;\n");
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "semgrep ok",
      stderr: "",
    } as any);

    const result = await runSemgrep(worktree, undefined, ["src/app.ts"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("semgrep ok");
    expect(mockExeca).toHaveBeenCalledWith(
      "uvx",
      ["semgrep", "scan", "--config=p/ci", "--error", "--", "src/app.ts"],
      expect.objectContaining({ cwd: worktree })
    );
  });

  it("skips default semgrep when no changed files still exist", async () => {
    const worktree = tempWorktree();

    const result = await runSemgrep(worktree, undefined, ["deleted.ts"]);

    expect(result).toMatchObject({
      exitCode: 0,
      output: "skipped: no changed files to scan",
    });
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("uses explicit PIPELINE_SEMGREP_COMMAND when provided", async () => {
    process.env.PIPELINE_SEMGREP_COMMAND = "make semgrep";
    const worktree = tempWorktree();
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runSemgrep(worktree);

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make semgrep",
      [],
      expect.objectContaining({ cwd: worktree, shell: true })
    );
  });

  it("fails on non-zero semgrep scan", async () => {
    const worktree = tempWorktree();
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("semgrep failed"), {
        exitCode: 2,
        stdout: "finding",
        stderr: "",
      })
    );

    const result = await runSemgrep(worktree);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("finding");
  });
});

// ─── runFallow ──────────────────────────────────────────────────────────────

describe("runFallow", () => {
  it("runs full fallow audit by default", async () => {
    const worktree = tempWorktree();
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "fallow ok",
      stderr: "",
    } as any);

    const result = await runFallow(worktree);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("fallow ok");
    expect(mockExeca).toHaveBeenCalledWith(
      "fallow",
      ["audit"],
      expect.objectContaining({ cwd: worktree })
    );
  });

  it("uses explicit PIPELINE_FALLOW_COMMAND when provided", async () => {
    process.env.PIPELINE_FALLOW_COMMAND = "make fallow";
    const worktree = tempWorktree();
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runFallow(worktree);

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make fallow",
      [],
      expect.objectContaining({ cwd: worktree, shell: true })
    );
  });
});

// ─── artifactExists ──────────────────────────────────────────────────────────

describe("artifactExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pipe3-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when file exists", () => {
    writeFileSync(join(tmpDir, "output.json"), "{}");
    expect(artifactExists(tmpDir, "output.json")).toBe(true);
  });

  it("returns false when file does not exist", () => {
    expect(artifactExists(tmpDir, "missing.json")).toBe(false);
  });
});

// ─── runJscpd ────────────────────────────────────────────────────────────────

describe("runJscpd", () => {
  it("excludes dependency and generated pipeline directories from the default scan", async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ duplicates: [] }),
      stderr: "",
    } as any);

    await runJscpd("/fake/worktree");

    expect(mockExeca).toHaveBeenCalledWith(
      "bunx",
      expect.arrayContaining([
        "jscpd",
        "--gitignore",
        "--ignore",
        expect.stringContaining("**/node_modules/**"),
        ".",
      ]),
      expect.objectContaining({ cwd: "/fake/worktree" })
    );
    const args = mockExeca.mock.calls[0]?.[1] as string[];
    const ignoreArg = args.at(args.indexOf("--ignore") + 1);
    expect(ignoreArg).toBeDefined();

    for (const ignoredPath of [
      "**/node_modules/**",
      "**/.codex/**",
      "**/.opencode/**",
      "**/.pipeline/host-resources/**",
      "**/.pipeline/skills/**",
      "**/.agents/skills/**",
    ]) {
      expect(ignoreArg).toContain(ignoredPath);
    }
  });

  it("returns populated violations when jscpd finds duplicates", async () => {
    const jscpdOutput = JSON.stringify({
      duplicates: [
        {
          format: "typescript",
          firstFile: { name: "src/a.ts", start: 1, end: 10 },
          secondFile: { name: "src/b.ts", start: 5, end: 14 },
          fragment: "const x = 1",
        },
      ],
    });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: jscpdOutput,
      stderr: "",
    } as any);

    const result = await runJscpd("/fake/worktree");
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].file).toBe("src/a.ts");
  });

  it("returns empty violations when no duplicates", async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ duplicates: [] }),
      stderr: "",
    } as any);

    const result = await runJscpd("/fake/worktree");
    expect(result.violations).toEqual([]);
  });

  it("returns empty violations when jscpd output is unparseable", async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "not json at all",
      stderr: "",
    } as any);

    const result = await runJscpd("/fake/worktree");
    expect(result.violations).toEqual([]);
  });
});
