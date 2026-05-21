import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock execa and fs first, before imports
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(real.existsSync),
    readFileSync: vi.fn(real.readFileSync),
    readdirSync: vi.fn(real.readdirSync),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
  };
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execa } from "execa";

const TRIVIAL_RE = /trivial/i;

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

const CONTEXT_FILE = "/fake/worktree/.pipeline/knowledge-context.md";

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── knowledge-inject ────────────────────────────────────────────────────────

describe("knowledgeInjectStep", () => {
  it("builds context string from rules and knowledge files", async () => {
    const { buildKnowledgeContext } = await import(
      "../src/mastra/steps/knowledge-inject.js"
    );

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "rule.md", isDirectory: () => false } as any,
    ]);
    mockReadFileSync.mockReturnValue("# Rule content");

    const ctx = buildKnowledgeContext("/fake/worktree");
    expect(typeof ctx).toBe("string");
    expect(ctx.length).toBeGreaterThan(0);
  });

  it("writes generated context to a stable .pipeline file", async () => {
    const { writeKnowledgeContextFile } = await import(
      "../src/mastra/steps/knowledge-inject.js"
    );

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((dir: any) => {
      if (String(dir).endsWith("rules")) {
        return [{ name: "test-first.md", isDirectory: () => false }] as any;
      }
      return [
        { name: "2026-01-01.md", isDirectory: () => false },
        { name: "2026-01-02.md", isDirectory: () => false },
      ] as any;
    });
    mockReadFileSync.mockImplementation((path: any) => {
      if (String(path).includes("test-first.md")) {
        return "# Write failing tests first";
      }
      return "# Learned knowledge";
    });

    const result = await writeKnowledgeContextFile("/fake/worktree");

    expect(result.contextFile).toBe(CONTEXT_FILE);
    expect(result.context).toContain("Current Rules");
    expect(result.context).toContain("Recent Learned Knowledge");
    expect(mockMkdir).toHaveBeenCalledWith("/fake/worktree/.pipeline", {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(CONTEXT_FILE, result.context);
  });

  it("truncates oversized context predictably", async () => {
    const { buildKnowledgeContext } = await import(
      "../src/mastra/steps/knowledge-inject.js"
    );

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "large.md", isDirectory: () => false } as any,
    ]);
    mockReadFileSync.mockReturnValue("x".repeat(200));

    const ctx = buildKnowledgeContext("/fake/worktree", { maxChars: 120 });

    expect(ctx.length).toBe(120);
    expect(ctx).toContain("Knowledge context truncated");
  });

  it("returns empty string when no rules or knowledge dir exists", async () => {
    const { buildKnowledgeContext } = await import(
      "../src/mastra/steps/knowledge-inject.js"
    );

    mockExistsSync.mockReturnValue(false);

    const ctx = buildKnowledgeContext("/fake/worktree");
    expect(ctx).toBe("");
  });
});

// ─── research step ───────────────────────────────────────────────────────────

describe("runResearch", () => {
  it("runs researcher agent and returns output", async () => {
    const { runResearch } = await import("../src/mastra/steps/research.js");

    mockExeca.mockResolvedValueOnce({
      stdout: "research findings",
      exitCode: 0,
    } as any);
    mockWriteFile.mockResolvedValue(undefined);

    const result = await runResearch({
      worktreePath: "/fake/worktree",
      prompt: "research this",
      contextFile: null,
      harness: "claude",
    });

    expect(result.output).toBe("research findings");
    expect(result.exitCode).toBe(0);
  });

  it("retries up to maxRetries on failure and returns last result", async () => {
    const { runResearch } = await import("../src/mastra/steps/research.js");

    mockExeca
      .mockRejectedValueOnce(
        Object.assign(new Error("fail"), {
          exitCode: 1,
          stdout: "err1",
          stderr: "",
        })
      )
      .mockResolvedValueOnce({ stdout: "success", exitCode: 0 } as any);
    mockWriteFile.mockResolvedValue(undefined);

    const result = await runResearch({
      worktreePath: "/fake/worktree",
      prompt: "research",
      contextFile: null,
      harness: "claude",
      maxRetries: 2,
    });

    expect(result.exitCode).toBe(0);
  });
});

// ─── red step (test-write) ───────────────────────────────────────────────────

describe("runRed", () => {
  it("rejects trivially-green tests (exit 0 means RED gate failed)", async () => {
    const { runRed } = await import("../src/mastra/steps/red.js");

    // Agent runs, then test runner exits 0 — RED gate FAILS (tests should fail)
    mockExeca
      .mockResolvedValueOnce({ stdout: "wrote tests", exitCode: 0 } as any) // agent
      .mockResolvedValueOnce({
        stdout: "All tests passed",
        exitCode: 0,
      } as any); // vitest

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
      }
      return "";
    });

    const result = await runRed({
      worktreePath: "/fake/worktree",
      prompt: "write failing tests",
      contextFile: null,
      harness: "claude",
      maxRetries: 1,
    });

    // After maxRetries exhausted on trivial pass, returns TRIVIAL_GREEN failure
    expect(result.redGatePassed).toBe(false);
    expect(result.reason).toMatch(TRIVIAL_RE);
    expect(result.output).toContain("All tests passed");
  });

  it("passes RED gate when tests fail (exit code 1)", async () => {
    const { runRed } = await import("../src/mastra/steps/red.js");

    mockExeca
      .mockResolvedValueOnce({ stdout: "wrote tests", exitCode: 0 } as any) // agent
      .mockRejectedValueOnce(
        Object.assign(new Error("tests fail"), {
          exitCode: 1,
          stdout: "✗ sum should work",
          stderr: "",
        })
      ); // vitest

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
      }
      return "";
    });

    const result = await runRed({
      worktreePath: "/fake/worktree",
      prompt: "write failing tests",
      contextFile: null,
      harness: "claude",
    });

    expect(result.redGatePassed).toBe(true);
    expect(result.failingTests).toContain("sum should work");
  });
});

// ─── green step (implement) ──────────────────────────────────────────────────

describe("runGreen", () => {
  it("passes when tests and typecheck both exit 0", async () => {
    const { runGreen } = await import("../src/mastra/steps/green.js");

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
      }
      return "";
    });
    mockExistsSync.mockReturnValue(true);

    mockExeca
      .mockResolvedValueOnce({ stdout: "implemented", exitCode: 0 } as any) // agent
      .mockResolvedValueOnce({ stdout: "all pass", exitCode: 0 } as any) // vitest
      .mockResolvedValueOnce({ stdout: "", exitCode: 0 } as any); // tsc

    const result = await runGreen({
      worktreePath: "/fake/worktree",
      prompt: "implement sum",
      contextFile: null,
      harness: "claude",
    });

    expect(result.greenGatePassed).toBe(true);
  });

  it("retries when tests fail and returns failure after maxRetries", async () => {
    const { runGreen } = await import("../src/mastra/steps/green.js");

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
      }
      return "";
    });
    mockExistsSync.mockReturnValue(false); // no tsconfig → typecheck skipped

    // agent always "succeeds" but tests keep failing
    mockExeca.mockImplementation((cmd: string | URL) => {
      if (String(cmd) === "claude") {
        return Promise.resolve({ stdout: "implemented", exitCode: 0 }) as any;
      }
      return Promise.reject(
        Object.assign(new Error("tests fail"), {
          exitCode: 1,
          stdout: "✗ sum broken",
          stderr: "",
        })
      );
    });

    const result = await runGreen({
      worktreePath: "/fake/worktree",
      prompt: "implement sum",
      contextFile: null,
      harness: "claude",
      maxRetries: 2,
    });

    expect(result.greenGatePassed).toBe(false);
  });
});

// ─── verify step ─────────────────────────────────────────────────────────────

describe("runVerify", () => {
  it("passes when static gates have no violations and LLM returns PASS", async () => {
    const { runVerify } = await import("../src/mastra/steps/verify.js");

    mockExistsSync.mockReturnValue(false); // no src/ files → no style violations
    mockExeca
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ duplicates: [] }),
        exitCode: 0,
      } as any) // jscpd
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ verdict: "PASS", evidence: [] }),
        exitCode: 0,
      } as any); // verifier agent

    const result = await runVerify({
      worktreePath: "/fake/worktree",
      prompt: "verify implementation",
      contextFile: null,
      harness: "claude",
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails when jscpd finds duplicates", async () => {
    const { runVerify } = await import("../src/mastra/steps/verify.js");

    mockExistsSync.mockReturnValue(false);
    mockExeca
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          duplicates: [
            {
              firstFile: { name: "src/a.ts", start: 1 },
              secondFile: { name: "src/b.ts" },
            },
          ],
        }),
        exitCode: 0,
      } as any) // jscpd
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ verdict: "PASS", evidence: [] }),
        exitCode: 0,
      } as any); // verifier

    const result = await runVerify({
      worktreePath: "/fake/worktree",
      prompt: "verify",
      contextFile: null,
      harness: "claude",
    });

    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

// ─── learn step ──────────────────────────────────────────────────────────────

describe("runLearn", () => {
  it("writes a knowledge file with task outcome", async () => {
    const { runLearn } = await import("../src/mastra/steps/learn.js");

    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await runLearn({
      worktreePath: "/fake/worktree",
      taskDescription: "add sum function",
      outcome: "PASS",
      violations: [],
      testOutput: "20 tests passed",
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [filePath, content] = mockWriteFile.mock.calls[0];
    expect(String(filePath)).toContain(".pipeline/knowledge/");
    expect(String(content)).toContain("add sum function");
    expect(String(content)).toContain("PASS");
  });

  it("includes violations in the knowledge file when present", async () => {
    const { runLearn } = await import("../src/mastra/steps/learn.js");

    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await runLearn({
      worktreePath: "/fake/worktree",
      taskDescription: "add feature",
      outcome: "FAIL",
      violations: [{ file: "src/a.ts", message: "inline style detected" }],
      testOutput: "1 test failed",
    });

    const content = String(mockWriteFile.mock.calls[0][1]);
    expect(content).toContain("inline style detected");
    expect(content).toContain("FAIL");
  });
});

// ─── workflow chain ──────────────────────────────────────────────────────────

describe("pipelineWorkflow", () => {
  it("exports a committed workflow with id ralph-loop", async () => {
    const { pipelineWorkflow } = await import(
      "../src/mastra/workflows/pipeline.js"
    );
    expect(pipelineWorkflow.id).toBe("ralph-loop");
    expect(pipelineWorkflow.committed).toBe(true);
  });

  it("has all required step ids", async () => {
    const { pipelineWorkflow } = await import(
      "../src/mastra/workflows/pipeline.js"
    );
    const stepIds = Object.keys(pipelineWorkflow.steps);
    expect(stepIds).toContain("knowledge-inject");
    expect(stepIds).toContain("research");
    expect(stepIds).toContain("red");
    expect(stepIds).toContain("green");
    expect(stepIds).toContain("verify");
    expect(stepIds).toContain("learn");
  });

  it("workflow inputSchema is defined with expected shape", async () => {
    const { pipelineWorkflow } = await import(
      "../src/mastra/workflows/pipeline.js"
    );
    expect(pipelineWorkflow.inputSchema).toBeDefined();
    // inputSchema is a Zod schema wrapped as StandardSchemaWithJSON
    expect(typeof pipelineWorkflow.inputSchema).toBe("object");
  });

  it("passes the generated context file to research, test-write, code-write, and verify roles", async () => {
    const { pipelineWorkflow } = await import(
      "../src/mastra/workflows/pipeline.js"
    );
    const inputData = {
      context: "built context",
      contextFile: CONTEXT_FILE,
      harness: "opencode" as const,
      task: "implement feature",
      worktreePath: "/fake/worktree",
    };

    mockExeca.mockResolvedValue({ stdout: "research", exitCode: 0 } as any);
    await pipelineWorkflow.steps.research.execute({ inputData } as any);
    expect(mockExeca).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["--file", CONTEXT_FILE])
    );

    mockExeca.mockReset();
    mockReadFileSync.mockImplementation((path: any) => {
      if (String(path).endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "vitest run" } });
      }
      return "";
    });
    mockExeca
      .mockResolvedValueOnce({ stdout: "tests written", exitCode: 0 } as any)
      .mockRejectedValueOnce(
        Object.assign(new Error("tests fail"), {
          exitCode: 1,
          stdout: "✗ expected failure",
          stderr: "",
        })
      );
    await pipelineWorkflow.steps.red.execute({ inputData } as any);
    expect(mockExeca.mock.calls[0]).toEqual([
      "opencode",
      expect.arrayContaining(["--file", CONTEXT_FILE]),
    ]);

    mockExeca.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockExeca.mockImplementation((cmd: string | URL) => {
      if (String(cmd) === "opencode") {
        return Promise.resolve({ stdout: "implemented", exitCode: 0 }) as any;
      }
      return Promise.resolve({ stdout: "all pass", exitCode: 0 }) as any;
    });
    await pipelineWorkflow.steps.green.execute({ inputData } as any);
    const greenAgentCall = mockExeca.mock.calls.find(
      ([cmd]) => String(cmd) === "opencode"
    );
    expect(greenAgentCall).toEqual([
      "opencode",
      expect.arrayContaining(["--file", CONTEXT_FILE]),
    ]);

    mockExeca.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockExeca.mockImplementation((cmd: string | URL) => {
      if (String(cmd) === "opencode") {
        return Promise.resolve({
          stdout: JSON.stringify({ verdict: "PASS", evidence: [] }),
          exitCode: 0,
        }) as any;
      }
      return Promise.resolve({
        stdout: JSON.stringify({ duplicates: [] }),
        exitCode: 0,
      }) as any;
    });
    await pipelineWorkflow.steps.verify.execute({
      inputData: {
        ...inputData,
        failingTests: [],
        greenGatePassed: true,
        redGatePassed: true,
        researchOutput: "research",
        testOutput: "all pass",
      },
    } as any);
    const verifyAgentCall = mockExeca.mock.calls.find(
      ([cmd]) => String(cmd) === "opencode"
    );
    expect(verifyAgentCall).toEqual([
      "opencode",
      expect.arrayContaining(["--file", CONTEXT_FILE]),
    ]);
  });
});

describe("evaluatePipelineOutcome", () => {
  const passingGateInput = {
    task: "add sum",
    harness: "claude" as const,
    worktreePath: "/fake/worktree",
    context: "",
    contextFile: CONTEXT_FILE,
    researchOutput: "research",
    redGatePassed: true,
    redGateReason: "RED gate passed: tests are failing as expected",
    redTestOutput: "1 failing test",
    failingTests: ["sum should work"],
    greenGatePassed: true,
    testOutput: "20 tests passed",
    typecheckOutput: "typecheck passed",
    verifyPassed: true,
    llmVerdict: "PASS" as const,
    llmEvidence: [],
    violations: [],
  };

  it("fails when RED gate fails and includes test evidence", async () => {
    const { evaluatePipelineOutcome } = await import(
      "../src/mastra/workflows/pipeline.js"
    );

    const result = evaluatePipelineOutcome({
      ...passingGateInput,
      redGatePassed: false,
      redGateReason:
        "trivial green: tests pass without implementation after all retries",
      redTestOutput: "All tests passed",
      failingTests: [],
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.failureDetails).toEqual([
      {
        gate: "RED",
        reason:
          "trivial green: tests pass without implementation after all retries",
        evidence: ["All tests passed"],
      },
    ]);
  });

  it("fails when GREEN gate fails and includes test/typecheck evidence", async () => {
    const { evaluatePipelineOutcome } = await import(
      "../src/mastra/workflows/pipeline.js"
    );

    const result = evaluatePipelineOutcome({
      ...passingGateInput,
      greenGatePassed: false,
      failingTests: ["sum should work"],
      testOutput: "expected 2 received 1",
      typecheckOutput: "src/sum.ts:1: Type error",
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.failureDetails).toEqual([
      {
        gate: "GREEN",
        reason: "GREEN gate failed: tests or typecheck did not pass",
        evidence: [
          "Failing tests: sum should work",
          "expected 2 received 1",
          "src/sum.ts:1: Type error",
        ],
      },
    ]);
  });

  it("fails when VERIFY gate fails and includes verification evidence", async () => {
    const { evaluatePipelineOutcome } = await import(
      "../src/mastra/workflows/pipeline.js"
    );

    const result = evaluatePipelineOutcome({
      ...passingGateInput,
      verifyPassed: false,
      llmVerdict: "FAIL",
      llmEvidence: ["missing edge case coverage"],
      violations: [
        {
          file: "src/sum.ts",
          line: 12,
          message: "duplicate implementation detected",
        },
      ],
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.failureDetails).toEqual([
      {
        gate: "VERIFY",
        reason: "VERIFY gate failed: verification checks did not pass",
        evidence: [
          "src/sum.ts:12: duplicate implementation detected",
          "LLM verifier verdict: FAIL",
          "missing edge case coverage",
        ],
      },
    ]);
  });

  it("passes only when RED, GREEN, and VERIFY gates all pass", async () => {
    const { evaluatePipelineOutcome } = await import(
      "../src/mastra/workflows/pipeline.js"
    );

    const result = evaluatePipelineOutcome(passingGateInput);

    expect(result).toEqual({ outcome: "PASS", failureDetails: [] });
  });
});
