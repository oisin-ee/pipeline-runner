import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";

interface ResearchOptions {
  agentAdapter?: AgentAdapter;
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  ticketId?: string | null;
  worktreePath: string;
}

interface ResearchResult {
  exitCode: number;
  output: string;
}

export async function runResearch(
  opts: ResearchOptions
): Promise<ResearchResult> {
  const {
    worktreePath,
    prompt,
    contextFile,
    harness,
    ticketId = null,
    agentAdapter = subprocessAgentAdapter,
    maxRetries = 2,
  } = opts;
  let lastResult: ResearchResult = { exitCode: 1, output: "" };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const researchPrompt = [
      "You are a researcher. Explore the codebase and understand what exists.",
      "Rules: (1) Read existing files. (2) Understand project structure. (3) Write a research.json summary.",
      "",
      `Task to research: ${prompt}`,
    ].join("\n");
    const result = await agentAdapter
      .run({
        contextFile,
        harness,
        prompt: researchPrompt,
        role: "researcher",
        ticketId,
        worktreePath,
      })
      .catch((err: { stdout?: string; exitCode?: number }) => ({
        stdout: err.stdout ?? "",
        exitCode: err.exitCode ?? 1,
      }));
    lastResult = { exitCode: result.exitCode, output: result.stdout };
    if (result.exitCode === 0) {
      break;
    }
  }

  if (lastResult.exitCode === 0) {
    const outputDir = join(worktreePath, ".pipeline");
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "research.json"),
      JSON.stringify({ output: lastResult.output })
    );
  }

  return lastResult;
}
