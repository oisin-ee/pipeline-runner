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
  loadPipelineConfig,
  type PipelineConfig,
  PipelineConfigError,
} from "./mastra/config.js";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
} from "./mastra/runner.js";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "./pipeline-init.js";
import {
  formatConfigError,
  type PipelineRuntimeResult,
  runPipelineFromConfig,
} from "./pipeline-runtime.js";
import { compileWorkflowPlan } from "./workflow-planner.js";

const PATH_SEPARATOR_RE = /[\\/]/;

interface PipeOptions {
  pipelineRunner?: typeof runPipelineFromConfig;
  workflow?: string;
}

/**
 * Config-driven `pipe` entrypoint. The workflow source of truth is
 * `.pipeline/pipeline.yaml`; missing YAML is a hard error.
 */
export function pipe(
  description: string,
  options: PipeOptions = {}
): Promise<void> {
  try {
    if (!description.trim()) {
      throw new Error("Task description is required");
    }

    const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    const runner = options.pipelineRunner ?? runPipelineFromConfig;
    return runConfiguredPipeline({
      pipelineRunner: runner,
      task: description,
      workflow: options.workflow,
      worktreePath,
    });
  } catch (err) {
    return Promise.reject(err as Error);
  }
}

interface RunFlags {
  workflow?: string;
}

interface RunInputs {
  pipelineRunner?: typeof runPipelineFromConfig;
  task: string;
  workflow?: string;
  worktreePath: string;
}

async function runConfiguredPipeline(inputs: RunInputs): Promise<void> {
  const runner = inputs.pipelineRunner ?? runPipelineFromConfig;
  const result = await runner({
    task: inputs.task,
    workflowId: inputs.workflow,
    worktreePath: inputs.worktreePath,
  });
  console.log(formatRuntimeResult(result));
  if (result.outcome === "FAIL") {
    throw new Error(
      [
        "Pipeline failed.",
        ...result.failureDetails.map((failure) =>
          failure.nodeId
            ? `- ${failure.nodeId}: ${failure.reason}`
            : `- ${failure.reason}`
        ),
      ].join("\n")
    );
  }
}

function formatRuntimeResult(result: PipelineRuntimeResult): string {
  return [
    `Pipeline complete: ${result.outcome}`,
    `Workflow: ${result.plan.workflowId}`,
    `Nodes: ${result.nodes.map((node) => `${node.nodeId}:${node.status}`).join(", ")}`,
    `Agent boundaries: ${result.agentInvocations.length}`,
  ].join("\n");
}

interface InstallCommandFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
  host?: CommandHostSelection;
}

interface InitFlags {
  overwrite?: boolean;
}

interface ValidateFlags {
  workflow?: string;
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("@oisincoveney/pipeline")
    .description("Run and install the oisin pipeline")
    .exitOverride();

  const runAction = async (descriptionParts: string[], flags: RunFlags) => {
    await pipe(descriptionParts.join(" "), {
      workflow: flags.workflow,
    });
  };

  program
    .command("run")
    .description("Run a workflow from .pipeline/pipeline.yaml")
    .argument("<description...>", "task description")
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action(runAction);

  program
    .command("pipe")
    .description("Alias for run")
    .argument("<description...>", "task description")
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action(runAction);

  program
    .command("validate")
    .description(
      "Validate .pipeline/pipeline.yaml and compile the workflow plan"
    )
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action((flags: ValidateFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd);
      const plan = compileWorkflowPlan(config, flags.workflow);
      console.log(
        `OK: ${plan.workflowId} (${plan.topologicalOrder.length} nodes)`
      );
    });

  program
    .command("explain-plan")
    .description("Explain workflow nodes, runners, gates, hooks, and artifacts")
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action((flags: ValidateFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd);
      console.log(formatWorkflowPlan(config, cwd, flags.workflow));
    });

  program
    .command("init")
    .description("Scaffold the default .pipeline/pipeline.yaml workflow")
    .option("--overwrite", "replace existing pipeline scaffold files", false)
    .action(async (flags: InitFlags) => {
      const result = await initPipelineProject({
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
        overwrite: flags.overwrite ?? false,
      });
      console.log(formatPipelineInitResult(result));
    });

  program
    .command("install-commands")
    .description(
      "Install generated slash-command adapters into this repository"
    )
    .addOption(
      new Option("--host <host>", "host command set to install")
        .choices(["all", "claude", "opencode", "codex", "kimi", "pi"])
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
  // When invoked via the `pipe` bin entry (or its legacy aliases), prepend
  // the `pipe` subcommand so Commander parses the remaining args correctly.
  const scriptName = argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
  if (scriptName === "pipe") {
    const firstArg = argv[2];
    const directSubcommands = new Set([
      "explain-plan",
      "init",
      "install-commands",
      "run",
      "validate",
    ]);
    if (firstArg && directSubcommands.has(firstArg)) {
      await program.parseAsync(argv, { from: "node" });
      return;
    }
    await program.parseAsync(
      [argv[0] ?? "node", argv[1] ?? "pipe", "run", ...argv.slice(2)],
      { from: "node" }
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
    name === "pipe" ||
    name === "oisin-pipeline"
  );
}

if (isCliEntrypoint(process.argv)) {
  runCli(process.argv).catch((err: unknown) => {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (err instanceof Error) {
      if (err instanceof PipelineConfigError) {
        console.error(formatConfigError(err));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
    console.error(String(err));
    process.exit(1);
  });
}

function formatWorkflowPlan(
  config: PipelineConfig,
  worktreePath: string,
  workflowId?: string
): string {
  const plan = compileWorkflowPlan(config, workflowId);
  const workflow = config.workflows[plan.workflowId];
  const lines = [`Workflow: ${plan.workflowId}`];
  lines.push(formatOrchestratorPlan(config, worktreePath));
  lines.push(
    `Batches: ${plan.parallelBatches
      .map((batch) => `[${batch.map((node) => node.id).join(", ")}]`)
      .join(" -> ")}`
  );
  for (const node of plan.topologicalOrder) {
    const agent = node.agent ? config.agents[node.agent] : undefined;
    const launch =
      agent && node.agent
        ? createRunnerLaunchPlan(config, {
            agentId: node.agent,
            nodeId: node.id,
            prompt: "<task>",
            worktreePath,
          })
        : null;
    lines.push(
      [
        `- ${node.id}`,
        `kind=${node.kind}`,
        `needs=${node.needs.join(",") || "none"}`,
        launch ? `runner=${launch.runnerId}` : "",
        launch ? `strategy=${launch.strategy}` : "",
        node.gates?.length ? `gates=${node.gates.length}` : "gates=0",
        node.artifacts?.length
          ? `artifacts=${node.artifacts.map((artifact) => artifact.path).join(",")}`
          : "artifacts=none",
        node.hooks?.length ? `hooks=${node.hooks.join(",")}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
  if (workflow?.hooks?.length) {
    lines.push(`Workflow hooks: ${workflow.hooks.join(", ")}`);
  }
  return lines.join("\n");
}

function formatOrchestratorPlan(
  config: PipelineConfig,
  worktreePath: string
): string {
  const launch = createOrchestratorLaunchPlan(config, {
    nodeId: "orchestrator",
    prompt: "<task>",
    worktreePath,
  });
  return [
    `Orchestrator: runner=${launch.runnerId}`,
    `strategy=${launch.strategy}`,
    config.orchestrator.model ? `model=${config.orchestrator.model}` : "",
    formatList("rules", config.orchestrator.rules),
    formatList("skills", config.orchestrator.skills),
    formatList("mcp_servers", config.orchestrator.mcp_servers),
    formatList("hooks", config.orchestrator.hooks),
  ]
    .filter(Boolean)
    .join(" ");
}

function formatList(label: string, items: string[] | undefined): string {
  return items?.length ? `${label}=${items.join(",")}` : "";
}
