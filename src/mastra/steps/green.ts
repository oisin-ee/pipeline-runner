import { runTests, runTypecheck } from "../gates.js";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";

interface GreenOptions {
  agentAdapter?: AgentAdapter;
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  ticketId?: string | null;
  worktreePath: string;
}

interface GreenResult {
  failingTests: string[];
  greenGatePassed: boolean;
  testOutput: string;
  typecheckOutput: string;
}

export async function runGreen(opts: GreenOptions): Promise<GreenResult> {
  const {
    worktreePath,
    prompt,
    contextFile,
    harness,
    ticketId = null,
    agentAdapter = subprocessAgentAdapter,
    maxRetries = 3,
  } = opts;
  let lastResult: GreenResult = {
    greenGatePassed: false,
    testOutput: "",
    typecheckOutput: "",
    failingTests: [],
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const codeWritePrompt = [
      "You are a code-writer. Your job is to implement code to make failing tests pass.",
      "Rules: (1) Read the test files to understand what to implement. (2) Write ONLY source code, never modify test files. (3) Make all tests pass.",
      "",
      `Task: ${prompt}`,
    ].join("\n");
    await agentAdapter
      .run({
        contextFile,
        harness,
        prompt: codeWritePrompt,
        role: "code-writer",
        ticketId,
        worktreePath,
      })
      .catch(() => ({ stdout: "", exitCode: 1 }));

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
