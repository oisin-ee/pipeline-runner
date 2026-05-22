import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runTests } from "../gates.js";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";

interface RedOptions {
  agentAdapter?: AgentAdapter;
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  ticketId?: string | null;
  worktreePath: string;
}

interface RedResult {
  failingTests: string[];
  output: string;
  reason: string;
  redGatePassed: boolean;
}

const SRC_FILE_RE = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

function walkSrcFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      out.push(...walkSrcFiles(full));
    } else if (entry.isFile() && SRC_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Enforce the test-writer phase contract: only `*.test.*` / `*.spec.*` files
 * created during this phase survive. The test-writer profile shares its rules
 * with the GREEN code-writer profile (`backend` / `frontend`), so the model
 * tends to write the implementation alongside the test. We delete those
 * impl files here so the RED gate (tests-must-fail) can fire correctly.
 */
function pruneNonTestArtifacts(
  worktreePath: string,
  baseline: Set<string>
): string[] {
  const after = walkSrcFiles(join(worktreePath, "src"));
  const deleted: string[] = [];
  for (const file of after) {
    if (baseline.has(file)) {
      continue;
    }
    if (TEST_FILE_RE.test(file)) {
      continue;
    }
    try {
      unlinkSync(file);
      deleted.push(file);
    } catch {
      // best-effort; if delete fails the test will still fail because the
      // gate captures the test output verbatim
    }
  }
  return deleted;
}

export async function runRed(opts: RedOptions): Promise<RedResult> {
  const {
    worktreePath,
    prompt,
    contextFile,
    harness,
    ticketId = null,
    agentAdapter = subprocessAgentAdapter,
    maxRetries = 3,
  } = opts;
  let lastTestOutput = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Snapshot existing source files BEFORE the test-writer runs so we can
    // detect (and prune) any implementation files it leaks into src/.
    const baselineSrc = new Set(walkSrcFiles(join(worktreePath, "src")));

    const testWritePrompt = [
      "You are a test-writer. Your ONLY job is to write FAILING unit tests.",
      "Rules: (1) Create ONE test file under `src/`, named `*.test.ts`. (2) DO NOT create or modify any other file. (3) The test MUST import the symbol(s) it tests from a module path that does NOT yet exist — that import failure is how the test fails. (4) Use vitest syntax with describe/it/expect.",
      "",
      `Task: ${prompt}`,
    ].join("\n");
    await agentAdapter
      .run({
        contextFile,
        harness,
        prompt: testWritePrompt,
        role: "test-writer",
        ticketId,
        worktreePath,
      })
      .catch(() => ({ stdout: "", exitCode: 1 }));

    // Delete any non-test files the test-writer leaked into src/.
    pruneNonTestArtifacts(worktreePath, baselineSrc);

    const testResult = await runTests(worktreePath);
    lastTestOutput = testResult.output;

    if (testResult.exitCode !== 0) {
      return {
        redGatePassed: true,
        failingTests: testResult.failingTests,
        reason: "RED gate passed: tests are failing as expected",
        output: testResult.output,
      };
    }
  }

  return {
    redGatePassed: false,
    failingTests: [],
    reason:
      "trivial green: tests pass without implementation after all retries",
    output: lastTestOutput,
  };
}
