import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Harness } from "../runner.js";
import { spawnAgent } from "../runner.js";

interface ResearchOptions {
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  worktreePath: string;
}

interface ResearchResult {
  exitCode: number;
  output: string;
}

export async function runResearch(
  opts: ResearchOptions
): Promise<ResearchResult> {
  const { worktreePath, prompt, contextFile, harness, maxRetries = 2 } = opts;
  let lastResult: ResearchResult = { exitCode: 1, output: "" };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await spawnAgent(
      harness,
      "researcher",
      prompt,
      contextFile,
      worktreePath
    ).catch((err: { stdout?: string; exitCode?: number }) => ({
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
