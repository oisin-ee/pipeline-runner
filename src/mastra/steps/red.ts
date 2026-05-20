import { runTests } from "../gates.js";
import type { Harness } from "../runner.js";
import { spawnAgent } from "../runner.js";

interface RedOptions {
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  worktreePath: string;
}

interface RedResult {
  failingTests: string[];
  output: string;
  reason: string;
  redGatePassed: boolean;
}

export async function runRed(opts: RedOptions): Promise<RedResult> {
  const { worktreePath, prompt, contextFile, harness, maxRetries = 3 } = opts;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const testWritePrompt = [
      "You are a test-writer. Your ONLY job is to write FAILING unit tests.",
      "Rules: (1) Create a test file (e.g. src/math.test.ts). (2) Tests MUST fail — do NOT implement the code. (3) Use vitest syntax with describe/it/expect.",
      "",
      `Task: ${prompt}`,
    ].join("\n");
    await spawnAgent(
      harness,
      "test-writer",
      testWritePrompt,
      contextFile,
      worktreePath
    ).catch(() => ({ stdout: "", exitCode: 1 }));

    const testResult = await runTests(worktreePath);

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
    output: "",
  };
}
