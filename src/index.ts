#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import {
  type CommandHostSelection,
  formatInstallCommandsResult,
  installCommands,
  parseCommandHost,
} from "./install-commands.js";
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
const PATH_SEPARATOR_RE = /[\\/]/;
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

interface InstallCommandFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
  host?: CommandHostSelection;
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("@oisincoveney/pipeline")
    .description("Run and install the oisin pipeline")
    .exitOverride();

  program
    .command("work-next")
    .description("Run the pipeline for a task")
    .argument("<description...>", "ticket id or task description")
    .action(async (descriptionParts: string[]) => {
      await workNext(descriptionParts.join(" "));
    });

  program
    .command("install-commands")
    .description(
      "Install generated slash-command adapters into this repository"
    )
    .addOption(
      new Option("--host <host>", "host command set to install")
        .choices(["all", "claude", "opencode", "codex", "pi"])
        .default("all")
        .argParser(parseCommandHost)
    )
    .option("--dry-run", "show planned changes without writing files")
    .option("--check", "fail if generated command files are missing or stale")
    .option("--force", "overwrite manually edited command files")
    .action(async (flags: InstallCommandFlags) => {
      const result = await installCommands(flags);
      console.log(formatInstallCommandsResult(result));
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createCliProgram();
  if (argv[1]?.endsWith("/work-next") || argv[1]?.endsWith("\\work-next")) {
    await program.parseAsync(
      [
        argv[0] ?? "node",
        argv[1] ?? "work-next",
        "work-next",
        ...argv.slice(2),
      ],
      {
        from: "node",
      }
    );
    return;
  }
  await program.parseAsync(argv, { from: "node" });
}

function scriptName(argv: string[]): string {
  return argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
}

function isCliEntrypoint(argv: string[]): boolean {
  const name = scriptName(argv);
  return (
    argv[1] === fileURLToPath(import.meta.url) ||
    name === "work-next" ||
    name === "oisin-pipeline"
  );
}

if (isCliEntrypoint(process.argv)) {
  runCli(process.argv).catch((err: unknown) => {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (err instanceof Error) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(String(err));
    process.exit(1);
  });
}
