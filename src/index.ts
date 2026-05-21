import { createSwarmTasks, markPhase } from "./mastra/backlog.js";
import { mastra } from "./mastra/index.js";

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

  const result = await run.start({
    inputData: { task: description, harness, worktreePath },
  });

  // Log result shape for debugging
  const outcome =
    (result as { result?: { outcome?: string } }).result?.outcome ?? "FAIL";
  await markPhase(`${parentId}-L`, "Done");
  console.log(`Pipeline complete: ${outcome}`);
}

const args = process.argv.slice(2);
if (args[0] === "work-next") {
  const description = args.slice(1).join(" ");
  workNext(description).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
