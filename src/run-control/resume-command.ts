import type { Command } from "commander";
import { loadMokaDbUrl } from "../moka-global-config";
import { type ResumeRunOptions, resumeRun } from "../pipeline-runtime";
import { workspaceRoot } from "./command-context";

interface ResumeFlags {
  entrypoint?: string;
  workflow?: string;
}

export function registerResumeSubcommand(program: Command): void {
  program
    .command("resume")
    .description(
      "Rehydrate a persisted run from the durable store and continue it"
    )
    .argument("<run-id>", "the persisted run id to resume")
    .argument("<description...>", "task description for the remaining nodes")
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option("--workflow <workflow>", "workflow id from package config")
    .action(
      async (runId: string, descriptionParts: string[], flags: ResumeFlags) => {
        await resumeRunFromCli(runId, descriptionParts.join(" "), flags);
      }
    );
}

async function resumeRunFromCli(
  runId: string,
  task: string,
  flags: ResumeFlags
): Promise<void> {
  try {
    const result = await resumeRun(resumeRunOptions(runId, task, flags));
    recordResumeResult(runId, result.outcome);
  } catch (error) {
    recordResumeFailure(runId, error);
  }
}

function resumeRunOptions(
  runId: string,
  task: string,
  flags: ResumeFlags
): ResumeRunOptions {
  return {
    dbUrl: loadMokaDbUrl(),
    entrypoint: flags.entrypoint,
    runId,
    task,
    workflowId: flags.workflow,
    worktreePath: workspaceRoot(),
  };
}

function recordResumeResult(runId: string, outcome: string): void {
  console.log(`Resumed run ${runId}: ${outcome}.`);
  process.exitCode = outcome === "PASS" ? process.exitCode : 1;
}

function recordResumeFailure(runId: string, error: unknown): void {
  process.stderr.write(
    `Failed to resume run ${runId}: ${errorMessage(error)}\n`
  );
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
