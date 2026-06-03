import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Mock node:fs selectively — only mock what tests need, real fs for artifact test
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(real.existsSync),
    readFileSync: vi.fn(real.readFileSync),
  };
});

import { existsSync, readFileSync } from "node:fs";
import { execa } from "execa";

import {
  artifactExists,
  runJscpd,
  runSemgrep,
  runTests,
  runTypecheck,
} from "../src/gates.js";

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PIPELINE_TEST_COMMAND;
  delete process.env.PIPELINE_TYPECHECK_COMMAND;
  delete process.env.PIPELINE_SEMGREP_COMMAND;
});

// ─── runTests ───────────────────────────────────────────────────────────────

describe("runTests", () => {
  it("returns exitCode 0 and empty failingTests on package test success", async () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "custom-test-runner" } });
      }
      return "";
    });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
    } as any);

    const result = await runTests("/fake/worktree");
    expect(result.exitCode).toBe(0);
    expect(result.failingTests).toEqual([]);
    expect(result.output).toContain("All tests passed");
    expect(mockExeca).toHaveBeenCalledWith(
      "npm",
      ["run", "test"],
      expect.objectContaining({ cwd: "/fake/worktree" })
    );
  });

  it("returns exitCode 1 and parses failing test names", async () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "custom-test-runner" } });
      }
      return "";
    });
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

    const result = await runTests("/fake/worktree");
    expect(result.exitCode).toBe(1);
    expect(result.failingTests).toContain("should do the thing");
    expect(result.failingTests).toContain("another failing test");
    expect(result.failingTests).not.toContain("passing test");
  });

  it("uses explicit PIPELINE_TEST_COMMAND when provided", async () => {
    process.env.PIPELINE_TEST_COMMAND = "make test";
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runTests("/fake/worktree");

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make test",
      [],
      expect.objectContaining({ cwd: "/fake/worktree", shell: true })
    );
  });

  it("fails when no test command can be found", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("missing package");
    });

    const result = await runTests("/fake/worktree");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No test command found");
    expect(mockExeca).not.toHaveBeenCalled();
  });
});

// ─── runTypecheck ────────────────────────────────────────────────────────────

describe("runTypecheck", () => {
  it("skips if no typecheck command is configured", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("missing package");
    });

    const result = await runTypecheck("/fake/worktree");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("skipped");
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("runs package typecheck script when present and returns exit code", async () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { typecheck: "custom-typecheck" } });
      }
      return "";
    });
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as any);

    const result = await runTypecheck("/fake/worktree");
    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "npm",
      ["run", "typecheck"],
      expect.objectContaining({ cwd: "/fake/worktree" })
    );
  });

  it("returns exitCode 1 when typecheck command fails", async () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { typecheck: "custom-typecheck" } });
      }
      return "";
    });
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("typecheck error"), {
        exitCode: 1,
        stdout: "typecheck failed",
        stderr: "",
      })
    );

    const result = await runTypecheck("/fake/worktree");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("typecheck failed");
  });

  it("uses explicit PIPELINE_TYPECHECK_COMMAND when provided", async () => {
    process.env.PIPELINE_TYPECHECK_COMMAND = "make typecheck";
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runTypecheck("/fake/worktree");

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make typecheck",
      [],
      expect.objectContaining({ cwd: "/fake/worktree", shell: true })
    );
  });
});

// ─── runSemgrep ─────────────────────────────────────────────────────────────

describe("runSemgrep", () => {
  it("runs semgrep ci config through uvx by default", async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "semgrep ok",
      stderr: "",
    } as any);

    const result = await runSemgrep("/fake/worktree");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("semgrep ok");
    expect(mockExeca).toHaveBeenCalledWith(
      "uvx",
      ["semgrep", "scan", "--config=p/ci", "--error", "."],
      expect.objectContaining({ cwd: "/fake/worktree" })
    );
  });

  it("uses explicit PIPELINE_SEMGREP_COMMAND when provided", async () => {
    process.env.PIPELINE_SEMGREP_COMMAND = "make semgrep";
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    } as any);

    const result = await runSemgrep("/fake/worktree");

    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "make semgrep",
      [],
      expect.objectContaining({ cwd: "/fake/worktree", shell: true })
    );
  });

  it("fails on non-zero semgrep scan", async () => {
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("semgrep failed"), {
        exitCode: 2,
        stdout: "finding",
        stderr: "",
      })
    );

    const result = await runSemgrep("/fake/worktree");

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("finding");
  });
});

// ─── artifactExists ──────────────────────────────────────────────────────────

describe("artifactExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Use real fs for artifact tests — restore mocks for existsSync
    mockExistsSync.mockRestore();
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
