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
    await spawnAgent(
      harness,
      "test-writer",
      prompt,
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
