import {
  applyPhaseLifecycle,
  createSwarmTasks,
  markPhase,
  type PipelineLifecycleResult,
} from "./mastra/backlog.js";
import { mastra } from "./mastra/index.js";

function normalizePipelineResult(result: unknown): PipelineLifecycleResult {
  const output = (result as { result?: Partial<PipelineLifecycleResult> })
    .result;
  return {
    outcome: output?.outcome === "PASS" ? "PASS" : "FAIL",
    failureDetails: Array.isArray(output?.failureDetails)
      ? output.failureDetails
      : [],
  };
}

export async function workNext(description: string): Promise<void> {
  if (!description.trim()) {
    throw new Error("Task description is required");
  }

  const harness = (process.env.PIPELINE_HARNESS ?? "claude") as
    | "claude"
    | "codex"
    | "opencode"
    | "pi";
  const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const parentId = `TASK-${Date.now()}`;

  await createSwarmTasks(parentId, worktreePath);

  const workflow = mastra.getWorkflow("pipelineWorkflow");
  const run = await workflow.createRun();

  console.log(`Starting pipeline for: ${description}`);
  await markPhase(`${parentId}-R`, "In Progress");

  let result: unknown;
  try {
    result = await run.start({
      inputData: { task: description, harness, worktreePath },
    });
  } catch (err) {
    await applyPhaseLifecycle(
      parentId,
      { outcome: "FAIL", failureDetails: [] },
      { alreadyStarted: ["R"] }
    );
    throw err;
  }

  const pipelineResult = normalizePipelineResult(result);
  await applyPhaseLifecycle(parentId, pipelineResult, {
    alreadyStarted: ["R"],
  });
  console.log(`Pipeline complete: ${pipelineResult.outcome}`);
}

const args = process.argv.slice(2);
if (args[0] === "work-next") {
  const description = args.slice(1).join(" ");
  workNext(description).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
