import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipelinePrimitive } from "../src/mastra/pipeline-primitive.js";
import type { AgentAdapter, AgentRole } from "../src/mastra/runner.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

const mockExeca = vi.mocked(execa);

describe("runPipelinePrimitive", () => {
  let worktreePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    worktreePath = mkdtempSync(join(tmpdir(), "pipeline-primitive-"));
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    mkdirSync(join(worktreePath, "rules"), { recursive: true });
    writeFileSync(
      join(worktreePath, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    writeFileSync(join(worktreePath, "tsconfig.json"), "{}");
    writeFileSync(
      join(worktreePath, "src", "clean.ts"),
      "export const ok = true;\n"
    );
    writeFileSync(
      join(worktreePath, "rules", "test-first.md"),
      "# Test first\n"
    );

    let testRuns = 0;
    mockExeca.mockImplementation(((file: string | URL, args: string[] = []) => {
      const command = String(file);
      if (command === "bunx" && args[0] === "vitest") {
        testRuns += 1;
        if (testRuns === 1) {
          return Promise.reject(
            Object.assign(new Error("red"), {
              exitCode: 1,
              stdout: "✗ primitive starts red",
              stderr: "",
            })
          );
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: "✓ primitive passes green",
          stderr: "",
        } as any);
      }
      if (command === "tsc") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" } as any);
      }
      if (command === "bunx" && args[0] === "jscpd") {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ duplicates: [] }),
          stderr: "",
        } as any);
      }
      return Promise.reject(
        new Error(`unexpected subprocess: ${command} ${args.join(" ")}`)
      );
    }) as any);
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs the lifecycle through an in-process agent adapter", async () => {
    const roles: AgentRole[] = [];
    const events: string[] = [];
    const agentAdapter: AgentAdapter = {
      run({ role }) {
        roles.push(role);
        if (role === "verifier") {
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: "PASS",
              evidence: ["in-process verifier passed"],
            }),
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: `${role} complete` });
      },
    };

    const result = await runPipelinePrimitive(
      {
        harness: "claude",
        task: "prove primitive adapters",
        worktreePath,
      },
      {
        agentAdapter,
        phaseReporter: {
          completed: (phase) => {
            events.push(`${phase}:completed`);
          },
          started: (phase) => {
            events.push(`${phase}:started`);
          },
        },
      }
    );

    const knowledgeFiles = await readdir(
      join(worktreePath, ".pipeline", "knowledge")
    );

    expect(result).toEqual({ outcome: "PASS", failureDetails: [] });
    expect(roles).toEqual([
      "researcher",
      "test-writer",
      "code-writer",
      "verifier",
    ]);
    expect(events).toEqual([
      "research:started",
      "research:completed",
      "red:started",
      "red:completed",
      "green:started",
      "green:completed",
      "verify:started",
      "verify:completed",
      "learn:started",
      "learn:completed",
    ]);
    expect(
      readFileSync(join(worktreePath, ".pipeline", "research.json"), "utf8")
    ).toContain("researcher complete");
    expect(knowledgeFiles.some((file) => file.endsWith(".md"))).toBe(true);
    expect(mockExeca.mock.calls.map(([command]) => command)).not.toContain(
      "claude"
    );
    expect(mockExeca.mock.calls.map(([command]) => command)).not.toContain(
      "codex"
    );
    expect(mockExeca.mock.calls.map(([command]) => command)).not.toContain(
      "opencode"
    );
    expect(mockExeca.mock.calls.map(([command]) => command)).not.toContain(
      "pi"
    );
  });
});
