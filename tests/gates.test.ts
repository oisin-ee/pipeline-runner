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
    readdirSync: vi.fn(real.readdirSync),
  };
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execa } from "execa";

import {
  artifactExists,
  runJscpd,
  runStyleGates,
  runTests,
  runTypecheck,
} from "../src/mastra/gates.js";

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── runTests ───────────────────────────────────────────────────────────────

describe("runTests", () => {
  it("returns exitCode 0 and empty failingTests on success", async () => {
    // package.json has vitest in scripts
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
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
  });

  it("returns exitCode 1 and parses failing test names", async () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
      }
      return "";
    });
    const fakeOutput = [
      "✗ should do the thing",
      "FAIL src/foo.test.ts",
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
});

// ─── runTypecheck ────────────────────────────────────────────────────────────

describe("runTypecheck", () => {
  it("skips if no tsconfig.json in worktreePath", async () => {
    mockExistsSync.mockReturnValueOnce(false);

    const result = await runTypecheck("/fake/worktree");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("skipped");
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("runs tsc --noEmit when tsconfig.json exists and returns exit code", async () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as any);

    const result = await runTypecheck("/fake/worktree");
    expect(result.exitCode).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith(
      "tsc",
      ["--noEmit"],
      expect.objectContaining({ cwd: "/fake/worktree" })
    );
  });

  it("returns exitCode 1 when tsc fails", async () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("tsc error"), {
        exitCode: 1,
        stdout: "error TS2322",
        stderr: "",
      })
    );

    const result = await runTypecheck("/fake/worktree");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("error TS2322");
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

// ─── runStyleGates ───────────────────────────────────────────────────────────

describe("runStyleGates", () => {
  const worktree = "/fake/worktree";

  beforeEach(() => {
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).includes("src")
    );
  });

  function makeDirents(names: string[]): any[] {
    return names.map((name) => ({
      name,
      isDirectory: () => false,
    }));
  }

  it("detects style={{ inline style violation", async () => {
    mockReaddirSync.mockReturnValueOnce(makeDirents(["App.tsx"]) as any);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("App.tsx")) {
        return '<div style={{ color: "red" }}>';
      }
      return "";
    });
    mockExistsSync.mockReturnValue(true);

    const result = await runStyleGates(worktree);
    const messages = result.violations.map((v) => v.message);
    expect(messages.some((m) => m.includes("inline style"))).toBe(true);
  });

  it("detects console.log in src files", async () => {
    mockReaddirSync.mockReturnValueOnce(makeDirents(["utils.ts"]) as any);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("utils.ts")) {
        return 'console.log("debug")';
      }
      return "";
    });
    mockExistsSync.mockReturnValue(true);

    const result = await runStyleGates(worktree);
    const messages = result.violations.map((v) => v.message);
    expect(messages.some((m) => m.includes("console.log"))).toBe(true);
  });

  it("detects arbitrary Tailwind class values", async () => {
    mockReaddirSync.mockReturnValueOnce(makeDirents(["Button.tsx"]) as any);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("Button.tsx")) {
        return 'className="text-[14px] font-bold"';
      }
      return "";
    });
    mockExistsSync.mockReturnValue(true);

    const result = await runStyleGates(worktree);
    const messages = result.violations.map((v) => v.message);
    expect(messages.some((m) => m.includes("arbitrary"))).toBe(true);
  });

  it("returns empty violations for clean files", async () => {
    mockReaddirSync.mockReturnValueOnce(makeDirents(["clean.ts"]) as any);
    mockReadFileSync.mockImplementation(() => "export const x = 1");
    mockExistsSync.mockReturnValue(true);

    const result = await runStyleGates(worktree);
    expect(result.violations).toEqual([]);
  });
});

// ─── runJscpd ────────────────────────────────────────────────────────────────

describe("runJscpd", () => {
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
