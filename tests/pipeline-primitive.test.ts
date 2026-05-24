import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  let originalTestCommand: string | undefined;
  let originalTypecheckCommand: string | undefined;
  let worktreePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalTestCommand = process.env.PIPELINE_TEST_COMMAND;
    originalTypecheckCommand = process.env.PIPELINE_TYPECHECK_COMMAND;
    process.env.PIPELINE_TEST_COMMAND = "project-test";
    process.env.PIPELINE_TYPECHECK_COMMAND = "project-typecheck";
    worktreePath = mkdtempSync(join(tmpdir(), "pipeline-primitive-"));
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    mkdirSync(join(worktreePath, "rules"), { recursive: true });
    writeFileSync(
      join(worktreePath, "package.json"),
      JSON.stringify({
        scripts: { test: "project-test", typecheck: "project-typecheck" },
      })
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
      if (command === "project-test") {
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
      if (command === "project-typecheck") {
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
    if (originalTestCommand === undefined) {
      delete process.env.PIPELINE_TEST_COMMAND;
    } else {
      process.env.PIPELINE_TEST_COMMAND = originalTestCommand;
    }
    if (originalTypecheckCommand === undefined) {
      delete process.env.PIPELINE_TYPECHECK_COMMAND;
    } else {
      process.env.PIPELINE_TYPECHECK_COMMAND = originalTypecheckCommand;
    }
    rmSync(worktreePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs the lifecycle through an in-process agent adapter", async () => {
    const roles: AgentRole[] = [];
    const events: string[] = [];
    const agentAdapter: AgentAdapter = {
      run({ role }) {
        roles.push(role);
        if (role === "researcher" && roles.length === 1) {
          mkdirSync(join(worktreePath, ".pipeline"), { recursive: true });
          writeFileSync(
            join(worktreePath, ".pipeline", "research.json"),
            JSON.stringify({
              findings: ["researcher complete"],
              ac: ["primitive passes"],
            })
          );
          return Promise.resolve({ exitCode: 0, stdout: "research done" });
        }
        if (role === "researcher") {
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              qdrant: { attempted: true, succeeded: true },
              evidence: ["stored lesson"],
            }),
          });
        }
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

    expect(result).toEqual({ outcome: "PASS", failureDetails: [] });
    expect(roles).toEqual([
      "researcher",
      "test-writer",
      "code-writer",
      "verifier",
      "researcher",
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
    expect(existsSync(join(worktreePath, ".pipeline", "knowledge"))).toBe(
      false
    );
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

  it("fails the lifecycle when qdrant-store is required but LEARN cannot prove success", async () => {
    const agentAdapter: AgentAdapter = {
      run({ role }) {
        if (role === "researcher") {
          if (!existsSync(join(worktreePath, ".pipeline", "research.json"))) {
            mkdirSync(join(worktreePath, ".pipeline"), { recursive: true });
            writeFileSync(
              join(worktreePath, ".pipeline", "research.json"),
              JSON.stringify({
                findings: ["researcher complete"],
                ac: ["primitive passes"],
              })
            );
            return Promise.resolve({ exitCode: 0, stdout: "research done" });
          }
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              qdrant: { attempted: true, succeeded: false },
              evidence: ["qdrant-store failed"],
            }),
          });
        }
        if (role === "verifier") {
          return Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({ verdict: "PASS", evidence: [] }),
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: `${role} complete` });
      },
    };

    const result = await runPipelinePrimitive(
      {
        harness: "claude",
        task: "prove qdrant learn gate",
        worktreePath,
      },
      { agentAdapter }
    );

    expect(result.outcome).toBe("FAIL");
    expect(result.failureDetails).toContainEqual(
      expect.objectContaining({
        gate: "LEARN",
        reason: "LEARN gate failed: qdrant-store did not succeed",
      })
    );
  });
});
