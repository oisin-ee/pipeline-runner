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
    const testWritePrompt = [
      "You are a test-writer. Your ONLY job is to write FAILING unit tests.",
      "Rules: (1) Follow this repository's existing test framework, file layout, naming, import/module, and fixture conventions. (2) Modify only test files or test fixtures needed for the test. (3) Do not create or modify production implementation. (4) The test must fail against the current implementation because the requested behavior is missing or wrong, not because of syntax errors, missing dependencies, missing imports, or changed build/test configuration.",
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
