import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { workNext } from "../src/index.js";

const mockExeca = vi.mocked(execa);

interface TracerScenario {
  verifierVerdict: "PASS" | "FAIL";
}

function writeFixtureWorktree(worktreePath: string): void {
  writeFileSync(
    join(worktreePath, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } })
  );
  writeFileSync(join(worktreePath, "tsconfig.json"), "{}");
  mkdirSync(join(worktreePath, "rules"));
  writeFileSync(
    join(worktreePath, "rules", "test-first.md"),
    "# Test first\n\nWrite the failing test before implementation."
  );
  mkdirSync(join(worktreePath, ".pipeline", "knowledge"), {
    recursive: true,
  });
  writeFileSync(
    join(worktreePath, ".pipeline", "knowledge", "2026-01-01.md"),
    "# Existing knowledge\n\nPrefer deterministic tracer fixtures."
  );
}

function installFakeHarness(
  worktreePath: string,
  scenario: TracerScenario
): { rolePrompts: string[] } {
  let testRunCount = 0;
  const rolePrompts: string[] = [];

  mockExeca.mockImplementation((cmd: string | URL, argsOrOptions?: unknown) => {
    const command = String(cmd);
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : undefined;
    if (command === "backlog") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }) as any;
    }

    if (command === "claude") {
      const prompt = args?.[2] ?? "";
      rolePrompts.push(prompt);

      if (prompt.includes("You are a researcher")) {
        return Promise.resolve({
          stdout: "researched deterministic integrated pipeline behavior",
          stderr: "",
          exitCode: 0,
        }) as any;
      }

      if (prompt.includes("You are a test-writer")) {
        writeFileSync(
          join(worktreePath, "pipeline-feature.test.ts"),
          "import { expect, it } from 'vitest';\nit('starts red', () => expect(false).toBe(true));\n"
        );
        return Promise.resolve({
          stdout: "wrote failing tracer test",
          stderr: "",
          exitCode: 0,
        }) as any;
      }

      if (prompt.includes("You are a code-writer")) {
        writeFileSync(
          join(worktreePath, "pipeline-feature.ts"),
          "export const tracerBullet = 'green';\n"
        );
        return Promise.resolve({
          stdout: "implemented tracer feature",
          stderr: "",
          exitCode: 0,
        }) as any;
      }

      if (prompt.includes("You are a code verifier")) {
        const evidence =
          scenario.verifierVerdict === "PASS"
            ? ["implementation matches tracer task"]
            : ["verifier found missing edge-case evidence"];
        return Promise.resolve({
          stdout: JSON.stringify({
            verdict: scenario.verifierVerdict,
            evidence,
          }),
          stderr: "",
          exitCode: 0,
        }) as any;
      }
    }

    if (command === "bunx" && args?.[0] === "vitest") {
      testRunCount += 1;
      if (testRunCount === 1) {
        return Promise.reject(
          Object.assign(new Error("red test failure"), {
            exitCode: 1,
            stdout: "✗ tracer feature should start red",
            stderr: "",
          })
        ) as any;
      }
      return Promise.resolve({
        stdout: "✓ tracer feature should pass after implementation",
        stderr: "",
        exitCode: 0,
      }) as any;
    }

    if (command === "bunx" && args?.[0] === "jscpd") {
      return Promise.resolve({
        stdout: JSON.stringify({ duplicates: [] }),
        stderr: "",
        exitCode: 0,
      }) as any;
    }

    if (command === "tsc") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }) as any;
    }

    throw new Error(`Unexpected command: ${command} ${args?.join(" ") ?? ""}`);
  });

  return { rolePrompts };
}

function backlogStatusUpdates(): [string, string][] {
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

function backlogCreateTaskIds(): string[] {
  return mockExeca.mock.calls
    .filter(([cmd, args]) => {
      const backlogArgs = args as string[] | undefined;
      return (
        cmd === "backlog" &&
        backlogArgs?.[0] === "task" &&
        backlogArgs?.[1] === "create"
      );
    })
    .map(([, args]) => {
      const backlogArgs = args as string[];
      return backlogArgs[2];
    });
}

function backlogNoteUpdates(): [string, string][] {
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

async function learnedOutcome(worktreePath: string): Promise<string> {
  const knowledgeDir = join(worktreePath, ".pipeline", "knowledge");
  const files = (await readdir(knowledgeDir)).filter((file) =>
    file.endsWith(".md")
  );
  const contents = await Promise.all(
    files.map((file) => readFile(join(knowledgeDir, file), "utf8"))
  );
  return contents.find((content) => content.includes("## Outcome:")) ?? "";
}

describe("PIPE-14 tracer-bullet pipeline", () => {
  let worktreePath: string;
  let originalHarness: string | undefined;
  let originalTargetPath: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    worktreePath = mkdtempSync(join(tmpdir(), "pipe-14-tracer-"));
    writeFixtureWorktree(worktreePath);
    originalHarness = process.env.PIPELINE_HARNESS;
    originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    process.env.PIPELINE_HARNESS = "claude";
    process.env.PIPELINE_TARGET_PATH = worktreePath;
    vi.spyOn(Date, "now").mockReturnValue(14);
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalHarness === undefined) {
      delete process.env.PIPELINE_HARNESS;
    } else {
      process.env.PIPELINE_HARNESS = originalHarness;
    }
    if (originalTargetPath === undefined) {
      delete process.env.PIPELINE_TARGET_PATH;
    } else {
      process.env.PIPELINE_TARGET_PATH = originalTargetPath;
    }
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(worktreePath, { force: true, recursive: true });
  });

  it("runs the integrated tracer to PASS and writes knowledge artifacts", async () => {
    const { rolePrompts } = installFakeHarness(worktreePath, {
      verifierVerdict: "PASS",
    });

    await workNext("PIPE-14 tracer bullet");

    const contextPath = join(worktreePath, ".pipeline", "knowledge-context.md");
    const researchPath = join(worktreePath, ".pipeline", "research.json");
    const learned = await learnedOutcome(worktreePath);

    expect(consoleLogSpy).toHaveBeenCalledWith("Pipeline complete: PASS");
    expect(existsSync(contextPath)).toBe(true);
    expect(readFileSync(contextPath, "utf8")).toContain("Current Rules");
    expect(readFileSync(contextPath, "utf8")).toContain(
      "Recent Learned Knowledge"
    );
    expect(readFileSync(researchPath, "utf8")).toContain(
      "researched deterministic integrated pipeline behavior"
    );
    expect(learned).toContain("## Outcome: PASS");
    expect(learned).toContain("tracer feature should pass");
    expect(rolePrompts.some((prompt) => prompt.includes("Test first"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("researcher"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("test-writer"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("code-writer"))).toBe(
      true
    );
    expect(rolePrompts.some((prompt) => prompt.includes("code verifier"))).toBe(
      true
    );
    expect(backlogCreateTaskIds()).toEqual([
      "TASK-14-R",
      "TASK-14-TW",
      "TASK-14-CW",
      "TASK-14-V",
      "TASK-14-L",
    ]);
    expect(backlogStatusUpdates()).toEqual([
      ["TASK-14-R", "In Progress"],
      ["TASK-14-R", "Done"],
      ["TASK-14-TW", "In Progress"],
      ["TASK-14-TW", "Done"],
      ["TASK-14-CW", "In Progress"],
      ["TASK-14-CW", "Done"],
      ["TASK-14-V", "In Progress"],
      ["TASK-14-V", "Done"],
      ["TASK-14-L", "In Progress"],
      ["TASK-14-L", "Done"],
    ]);
    expect(backlogNoteUpdates()).toEqual([]);
  });

  it("runs the integrated tracer to FAIL and preserves failed phase evidence", async () => {
    installFakeHarness(worktreePath, { verifierVerdict: "FAIL" });

    await workNext("PIPE-14 tracer bullet");

    const learned = await learnedOutcome(worktreePath);
    const notes = backlogNoteUpdates();

    expect(consoleLogSpy).toHaveBeenCalledWith("Pipeline complete: FAIL");
    expect(learned).toContain("## Outcome: FAIL");
    expect(learned).toContain("tracer feature should pass");
    expect(backlogStatusUpdates()).toEqual([
      ["TASK-14-R", "In Progress"],
      ["TASK-14-R", "Done"],
      ["TASK-14-TW", "In Progress"],
      ["TASK-14-TW", "Done"],
      ["TASK-14-CW", "In Progress"],
      ["TASK-14-CW", "Done"],
      ["TASK-14-V", "In Progress"],
    ]);
    expect(backlogStatusUpdates()).not.toContainEqual(["TASK-14-V", "Done"]);
    expect(backlogStatusUpdates()).not.toContainEqual([
      "TASK-14-L",
      "In Progress",
    ]);
    expect(notes).toEqual([
      [
        "TASK-14-V",
        "VERIFY gate failed: VERIFY gate failed: verification checks did not pass\n\nEvidence:\n- LLM verifier verdict: FAIL\n- verifier found missing edge-case evidence",
      ],
    ]);
  });
});
