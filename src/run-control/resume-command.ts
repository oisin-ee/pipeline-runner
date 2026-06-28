import type { Command } from "commander";
import { buildMokaSubmitInputFromCli } from "../cli/submit-options";
import { loadPipelineConfig } from "../config";
import { loadMokaDbUrl, loadMokaGlobalConfig } from "../moka-global-config";
import { type MokaSubmitOutput, submitMoka } from "../moka-submit";
import {
  type ResubmitRemoteRunInput,
  type ResumeRunOptions,
  type ResumeRunResult,
  resumeRunByOrigin,
} from "../pipeline-runtime";
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
    const result = await resumeRunByOrigin(
      resumeRunOptions(runId, task, flags),
      {
        resubmit: defaultResubmitRemoteRun,
      }
    );
    reportResumeResult(runId, result);
  } catch (error) {
    recordResumeFailure(runId, error);
  }
}

/**
 * PIPE-94.8: re-submit a remote-origin run through the PIPE-94.4 submit path.
 * Lives in the CLI/run-control layer (not in core `pipeline-runtime`) so the
 * core stays free of a CLI/submit import cycle. The submission context (event
 * sink, image, namespace, secrets, broker auth) is reassembled from the Moka
 * global config by the SAME builder a fresh `moka submit` uses
 * ({@link buildMokaSubmitInputFromCli}); the PERSISTED schedule is then
 * substituted so the ORIGINAL run graph re-submits — not a freshly planned one —
 * and the runId is pinned via `generateRunId` so createRun stays idempotent
 * (progress preserved). The full DAG re-submits; the in-pod skip-already-passed
 * check drains only the remaining nodes.
 */
function defaultResubmitRemoteRun(
  input: ResubmitRemoteRunInput
): Promise<MokaSubmitOutput> {
  const worktreePath = input.worktreePath ?? process.cwd();
  const config =
    input.config ??
    loadPipelineConfig(worktreePath, { allowMissingLintFileReferences: true });
  const submitInput = buildMokaSubmitInputFromCli({
    config,
    cwd: worktreePath,
    flags: {},
    globalConfig: loadMokaGlobalConfig(),
    input: [input.task],
  });
  if (submitInput.type !== "graph") {
    throw new Error(
      `Cannot re-submit remote run '${input.runId}': expected a graph submission.`
    );
  }
  return submitMoka(
    {
      ...submitInput,
      schedulePath: undefined,
      scheduleYaml: input.scheduleYaml,
    },
    { generateRunId: () => input.runId }
  );
}

function reportResumeResult(runId: string, result: ResumeRunResult): void {
  if (result.kind === "remote") {
    console.log(
      `Re-submitted run ${runId} to Argo (workflow ${result.submission.workflowName}).`
    );
    return;
  }
  recordResumeResult(runId, result.result.outcome);
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
