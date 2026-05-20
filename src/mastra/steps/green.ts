import { runTests, runTypecheck } from "../gates.js";
import type { Harness } from "../runner.js";
import { spawnAgent } from "../runner.js";

interface GreenOptions {
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  worktreePath: string;
}

interface GreenResult {
  failingTests: string[];
  greenGatePassed: boolean;
  testOutput: string;
  typecheckOutput: string;
}

export async function runGreen(opts: GreenOptions): Promise<GreenResult> {
  const { worktreePath, prompt, contextFile, harness, maxRetries = 3 } = opts;
  let lastResult: GreenResult = {
    greenGatePassed: false,
    testOutput: "",
    typecheckOutput: "",
    failingTests: [],
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await spawnAgent(
      harness,
      "code-writer",
      prompt,
      contextFile,
      worktreePath
    ).catch(() => ({ stdout: "", exitCode: 1 }));

    const [testResult, typecheckResult] = await Promise.all([
      runTests(worktreePath),
      runTypecheck(worktreePath),
    ]);

    lastResult = {
      greenGatePassed:
        testResult.exitCode === 0 && typecheckResult.exitCode === 0,
      testOutput: testResult.output,
      typecheckOutput: typecheckResult.output,
      failingTests: testResult.failingTests,
    };

    if (lastResult.greenGatePassed) {
      break;
    }
  }

  return lastResult;
}
