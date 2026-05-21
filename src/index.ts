import {
  applyPhaseLifecycle,
  createSwarmTasks,
  markPhase,
  type PipelineLifecycleResult,
} from "./mastra/backlog.js";
import {
  type PipelinePrimitiveInput,
  runPipelinePrimitive,
} from "./mastra/pipeline-primitive.js";
import { subprocessAgentAdapter } from "./mastra/runner.js";

const SUPPORTED_HARNESSES = ["claude", "codex", "opencode", "pi"] as const;

type PipelineHarness = (typeof SUPPORTED_HARNESSES)[number];

function parsePipelineHarness(value: string | undefined): PipelineHarness {
  const harness = value ?? "claude";
  if (SUPPORTED_HARNESSES.includes(harness as PipelineHarness)) {
    return harness as PipelineHarness;
  }

  throw new Error(
    `Unsupported PIPELINE_HARNESS "${harness}". Supported values: ${SUPPORTED_HARNESSES.join(
      ", "
    )}.`
  );
}

interface WorkNextOptions {
  pipelineRunner?: (
    input: PipelinePrimitiveInput
  ) => Promise<PipelineLifecycleResult>;
}

export async function workNext(
  description: string,
  options: WorkNextOptions = {}
): Promise<void> {
  if (!description.trim()) {
    throw new Error("Task description is required");
  }

  const harness = parsePipelineHarness(process.env.PIPELINE_HARNESS);
  const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const parentId = `TASK-${Date.now()}`;
  const pipelineRunner =
    options.pipelineRunner ??
    ((input: PipelinePrimitiveInput) =>
      runPipelinePrimitive(input, { agentAdapter: subprocessAgentAdapter }));

  await createSwarmTasks(parentId, worktreePath);

  console.log(`Starting pipeline for: ${description}`);
  await markPhase(`${parentId}-R`, "In Progress");

  let pipelineResult: PipelineLifecycleResult;
  try {
    pipelineResult = await pipelineRunner({
      harness,
      task: description,
      worktreePath,
    });
  } catch (err) {
    await applyPhaseLifecycle(
      parentId,
      { outcome: "FAIL", failureDetails: [] },
      { alreadyStarted: ["R"] }
    );
    throw err;
  }

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
